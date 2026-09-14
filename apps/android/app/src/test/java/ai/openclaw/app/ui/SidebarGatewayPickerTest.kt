package ai.openclaw.app.ui

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.AndroidScreenshotScene
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.NodeRuntimeMode
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.drainWithMainLooper
import ai.openclaw.app.gateway.GatewayEndpoint
import ai.openclaw.app.gateway.GatewayRegistryEntry
import ai.openclaw.app.gateway.GatewayRegistryEntryKind
import ai.openclaw.app.ui.chat.ChatScreen
import ai.openclaw.app.ui.chat.PendingAttachment
import ai.openclaw.app.ui.design.ClawDesignTheme
import android.content.Context
import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isPopup
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.unit.dp
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.QueueDispatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowToast
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.net.InetAddress

/** Real sidebar, ViewModel/runtime and composer; no replacement picker is installed on the base. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1000dp-h800dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SidebarGatewayPickerTest {
  @get:Rule val composeRule = createComposeRule()
  private val store = ViewModelStore()
  private val mounted = mutableStateOf(true)
  private val servers = mutableListOf<MockWebServer>()
  private lateinit var app: NodeApp
  private lateinit var prefs: SecurePrefs
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private var originalRuntime: NodeRuntime? = null
  private var animatorScale: String? = null

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    prefs = SecurePrefs(app, app.getSharedPreferences("sidebar-gateway-proof", Context.MODE_PRIVATE))
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Chat)
    runtime = NodeRuntime(app, prefs, NodeRuntimeMode.ScreenshotFixture)
    originalRuntime = app.peekRuntime()
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    store.put("sidebar", model)
    model.enterScreenshotFixtureMode(AndroidScreenshotScene.Chat)
    animatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
  }

  @After
  fun tearDown() {
    composeRule.runOnIdle { mounted.value = false }
    store.clear()
    bindNodeRuntimeTestFixture(app, originalRuntime)
    closeNodeRuntimeTestFixture(runtime)
    servers.forEach { it.shutdown() }
    Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, animatorScale)
    AndroidScreenshotFixture.configure(AndroidScreenshotScene.Home)
  }

  @Test
  fun emptyRegistryOffersExistingGatewaySetup() {
    prefs.gatewayRegistry.entries.value
      .forEach { prefs.gatewayRegistry.remove(it.stableId) }
    showSidebarAndComposer()
    capture("empty-registry")
    composeRule.onNodeWithText("Add Gateway").assertIsDisplayed().performClick()
    composeRule.runOnIdle {
      org.junit.Assert.assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value)
    }
  }

  @Test
  fun queuedGatewayHandoffProtectsTheActualComposer() {
    val target =
      GatewayRegistryEntry(
        stableId = "manual|127.0.0.1|19876",
        kind = GatewayRegistryEntryKind.MANUAL,
        name = "Local QA B",
        host = "127.0.0.1",
        port = 19876,
        tls = false,
      )
    prefs.gatewayRegistry.upsert(target)
    showSidebarAndComposer()
    val barrier = ReflectionHelpers.getField<Mutex>(runtime, "gatewaySwitchMutex")
    check(barrier.tryLock())
    try {
      composeRule.runOnIdle { model.switchToGateway(target.stableId) }
      composeRule.waitUntil {
        ReflectionHelpers.getField<Any?>(runtime, "gatewayConnectionOperation") != null
      }
      capture("queued-handoff")
      composeRule.onNodeWithText("Message OpenClaw").assertIsNotEnabled()
    } finally {
      // Retire queued work before releasing the barrier: no real endpoint is contacted.
      composeRule.runOnIdle { runtime.disconnect() }
      barrier.unlock()
    }
  }

  @Test
  fun savedOfflineGatewaysSwitchBothWaysWithoutMovingFinishedDraftsOrAttachments() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("Alpha draft")
    val alphaOwner = model.captureChatShareOwner()
    val attachment = PendingAttachment("alpha-file", "alpha.txt", "text/plain", "QQ==")
    composeRule.runOnIdle { model.chatComposerState.addAttachments(alphaOwner, listOf(attachment)) }
    openPicker()
    gatewayItem(alpha).assertIsSelected().performClick()
    composeRule.runOnIdle { assertFalse(runtime.gatewayConnectionHandoff.value.pending) }
    choose(beta)
    composeRule.onNodeWithText("Message OpenClaw").assertIsEnabled()
    composeRule.onNode(hasSetTextAction()).performTextReplacement("Beta draft")
    choose(alpha)
    composeRule.runOnIdle { assertEquals("Restored composer owner", alphaOwner, model.captureChatShareOwner()) }
    composeRule.onNodeWithText("Alpha draft").assertIsEnabled()
    composeRule.runOnIdle {
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[alphaOwner])
      assertEquals("Alpha draft", model.chatComposerState.textDrafts[alphaOwner])
    }
    capture("multiple-offline-after-switch")
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    gatewayItem(beta).assertIsNotSelected()
    capture("native-gateway-menu", popup = true)
    composeRule.onNodeWithText("Manage Gateways").performClick()
    composeRule.runOnIdle { assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value) }
  }

  @Test
  fun quickSwitchReadsRecordingImportAndSendOwnersAtSelectionTime() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    focus(alpha)
    showSidebarAndComposer()
    openPicker()
    composeRule.runOnIdle { assertTrue(runtime.tryAcquireVoiceNoteMic()) }
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertTrue(ShadowToast.getTextOfLatestToast().contains("Finish recording"))
      runtime.releaseVoiceNoteMic()
    }
    val owner = model.captureChatShareOwner()
    val media = requireNotNull(model.chatComposerState.beginMediaAcquisition(owner))
    val importing = requireNotNull(model.chatComposerState.beginMediaImport(owner, media, model.mainSessionKey.value))
    openPicker()
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertTrue(ShadowToast.getTextOfLatestToast().contains("Finish importing"))
      model.chatComposerState.cancelMediaImport(importing)
      model.chatComposerState.textDrafts[owner] = "Pending admission"
    }
    val send = requireNotNull(model.chatComposerState.beginSend(owner).request)
    openPicker()
    composeRule.onNodeWithText(beta.name).performClick()
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      model.chatComposerState.completeSend(send, false)
      model.acknowledgeChatComposerSendAdmission(owner, send.commandId)
    }
    choose(beta)
  }

  @Test
  fun registryUpdatesDoNotRelabelTheActualFocusWithSavedIntent() {
    val alpha = savedGateway("Local QA Alpha")
    focus(alpha)
    showSidebarAndComposer()
    composeRule.onNodeWithTag("sidebar-gateway-control").performClick()
    composeRule.runOnIdle { assertEquals(SettingsRoute.Gateway, model.requestedSettingsRoute.value) }
    val beta = savedGateway("Local QA Beta")
    composeRule.runOnIdle { prefs.gatewayRegistry.setActive(beta.stableId) }
    openPicker()
    gatewayItem(alpha).assertIsSelected()
    gatewayItem(beta).assertIsNotSelected()
    composeRule.runOnIdle { prefs.gatewayRegistry.remove(alpha.stableId) }
    composeRule.onNodeWithText("Gateways").assertIsDisplayed()
    // Removing the focused registration must not select the remaining saved entry.
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
    }
  }

  @Test
  fun supersedingQueuedSwitchKeepsProtectionUntilTheWinningOfflineCommit() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    val gamma = savedGateway("Local QA Gamma")
    focus(alpha)
    showSidebarAndComposer()
    val barrier = ReflectionHelpers.getField<Mutex>(runtime, "gatewaySwitchMutex")
    check(barrier.tryLock())
    try {
      openPicker()
      gatewayItem(beta).performClick()
      composeRule.runOnIdle {
        assertTrue("Admission is published before dispatch returns", runtime.gatewayConnectionHandoff.value.pending)
        assertFalse(runtime.tryAcquireDictationMic())
        model.switchGatewayFromSidebar(alpha.stableId)
        assertTrue(runtime.gatewayConnectionHandoff.value.pending)
        // Settings/notification-style consumers still supersede through the existing owner.
        model.switchToGateway(gamma.stableId)
      }
      composeRule.onNodeWithText("Message OpenClaw").assertIsNotEnabled()
    } finally {
      barrier.unlock()
    }
    composeRule.waitUntil {
      composeRule.runOnIdle {
        runtime.gatewayConnectionHandoff.value.let { !it.pending && it.focusedStableId == gamma.stableId }
      }
    }
    composeRule.onNodeWithText("Message OpenClaw").assertIsEnabled()
    composeRule.runOnIdle { assertFalse(runtime.gatewayConnectionDisplay.value.isConnected) }
  }

  @Test
  fun unavailableDiscoveryKeepsFocusAndLateAuthorizedMediaStaysWithItsOwner() {
    val alpha = savedGateway("Local QA Alpha")
    val beta = savedGateway("Local QA Beta")
    val unavailable = GatewayRegistryEntry("bonjour-missing", GatewayRegistryEntryKind.DISCOVERED, "Saved offline gateway")
    prefs.gatewayRegistry.upsert(unavailable)
    focus(alpha)
    showSidebarAndComposer()
    openPicker()
    gatewayItem(unavailable).performClick()
    composeRule.waitUntil {
      composeRule.runOnIdle { model.requestedSettingsRoute.value == SettingsRoute.Gateway }
    }
    composeRule.runOnIdle {
      assertEquals(alpha.stableId, runtime.gatewayConnectionHandoff.value.focusedStableId)
      assertFalse(runtime.gatewayConnectionHandoff.value.pending)
    }
    val owner = model.captureChatShareOwner()
    val authorization = requireNotNull(model.chatComposerState.beginMediaAcquisition(owner))
    // Another existing navigation consumer can switch while the external picker is away.
    composeRule.runOnIdle { model.switchToGateway(beta.stableId) }
    composeRule.waitUntil {
      composeRule.runOnIdle { runtime.gatewayConnectionHandoff.value.let { !it.pending && it.focusedStableId == beta.stableId } }
    }
    val attachment = PendingAttachment("late-file", "late-alpha.txt", "text/plain", "QQ==")
    composeRule.runOnIdle {
      model.chatComposerState.addAuthorizedAttachments(owner, authorization, listOf(attachment))
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[owner])
      assertTrue(
        model.chatComposerState.attachments.value[model.captureChatShareOwner()]
          .isNullOrEmpty(),
      )
    }
  }

  private fun savedGateway(name: String): GatewayRegistryEntry {
    val server =
      MockWebServer().apply {
        (dispatcher as QueueDispatcher).setFailFast(MockResponse().setResponseCode(503))
        start(InetAddress.getByName("127.0.0.1"), 0)
      }
    servers += server
    val endpoint = GatewayEndpoint.manual("127.0.0.1", server.port, false)
    return GatewayRegistryEntry(endpoint.stableId, GatewayRegistryEntryKind.MANUAL, name, endpoint.host, endpoint.port, false).also {
      prefs.gatewayRegistry.upsert(it)
    }
  }

  private fun focus(entry: GatewayRegistryEntry) {
    // Replace the screenshot-only main-session key with the real device-owned offline route.
    runtime.prepareForGatewaySetup()
    drainWithMainLooper { withTimeout(5_000) { runtime.switchToGateway(entry.stableId) } }
  }

  private fun gatewayItem(entry: GatewayRegistryEntry) = composeRule.onNode(hasText(entry.name) and hasAnyAncestor(isPopup()))

  private fun openPicker() {
    composeRule.onNodeWithTag("sidebar-gateway-control").performClick()
    composeRule.onNodeWithText("Manage Gateways").assertIsDisplayed()
  }

  private fun choose(entry: GatewayRegistryEntry) {
    openPicker()
    gatewayItem(entry).performClick()
    composeRule.waitUntil {
      composeRule.runOnIdle {
        runtime.gatewayConnectionHandoff.value.let { !it.pending && it.focusedStableId == entry.stableId }
      }
    }
    composeRule.waitForIdle()
  }

  private fun showSidebarAndComposer() {
    composeRule.setContent {
      if (mounted.value) {
        val connection by model.gatewayConnectionDisplay.collectAsState()
        val agents by model.gatewayAgents.collectAsState()
        val sessions by model.chatSessions.collectAsState()
        val sessionKey by model.chatSessionKey.collectAsState()
        ClawDesignTheme {
          Row(Modifier.fillMaxSize().testTag("gateway-proof")) {
            Box(Modifier.width(300.dp)) {
              OpenClawSidebar(
                viewModel = model,
                agents = agents,
                selectedAgentId = null,
                sessions = sessions,
                activeSessionKey = sessionKey,
                activeDestination = SidebarDestination.Home,
                connection = connection,
                visible = true,
                showCloseButton = false,
                onClose = {},
                onDragActiveChange = {},
                onNewSession = {},
                onSelectAgent = {},
                onSelectSession = {},
                onSelectCatalogSession = {},
                onCreateCatalogSession = {},
                onSelectDestination = {},
              )
            }
            Box(Modifier.weight(1f)) {
              ChatScreen(
                viewModel = model,
                talkActive = false,
                showSidebarButton = false,
                onOpenSidebar = {},
                onToggleTalk = {},
                onOpenDashboard = {},
                onOpenGatewaySettings = {},
              )
            }
          }
        }
      }
    }
    composeRule.waitForIdle()
  }

  private fun capture(
    name: String,
    popup: Boolean = false,
  ) {
    val directory = System.getenv("OPENCLAW_GATEWAY_PROOF_DIR") ?: return
    val target = File(directory, "$name.png")
    requireNotNull(target.parentFile).mkdirs()
    target.outputStream().use { output ->
      val node = if (popup) composeRule.onNode(isPopup()) else composeRule.onNodeWithTag("gateway-proof")
      node.captureToImage().asAndroidBitmap().compress(Bitmap.CompressFormat.PNG, 100, output)
    }
  }
}
