import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createVoiceTranscriptOperationRegistry,
  VOICE_TRANSCRIPT_QUEUE_POLICY,
} from "./voice-transcript.js";

describe("VoiceTranscriptOperationRegistry", () => {
  it.each([false, true])(
    "rejects close after an accepted operation fails and releases the failed owner (recovery=%s)",
    async (conditional) => {
      const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
      const first = createDeferred();
      const key = "agent\0voice-failure";
      const active = registry.run(key, () => first.promise);
      const failure = new Error("persistence failed");
      const failed = registry.run(key, () => {
        throw failure;
      });
      const closeOperation = vi.fn(async () => true);
      const closed = registry.close(key, closeOperation, conditional);
      const explicit = conditional ? registry.close(key, closeOperation) : undefined;
      const completions = Promise.all([
        expect(active).resolves.toBeUndefined(),
        expect(failed).rejects.toBe(failure),
        expect(closed).rejects.toBe(failure),
        ...(explicit ? [expect(explicit).rejects.toBe(failure)] : []),
      ]);

      first.resolve();
      await completions;

      expect(closeOperation).not.toHaveBeenCalled();
      await expect(registry.run(key, async () => "fresh owner")).resolves.toBe("fresh owner");
    },
  );

  it("keeps overflow terminal through drain and releases it only on close", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const first = createDeferred();
    const key = "agent\0voice-overflow";
    const accepted = [
      registry.run(key, async () => await first.promise),
      ...Array.from({ length: VOICE_TRANSCRIPT_QUEUE_POLICY.maxPendingCount }, () =>
        registry.run(key, async () => undefined),
      ),
    ];

    await expect(registry.run(key, async () => undefined)).rejects.toThrow(
      "voice transcript persistence queue capacity exceeded",
    );
    first.resolve();
    await Promise.all(accepted);

    const controlOperation = vi.fn();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).rejects.toThrow("voice transcript persistence queue capacity exceeded");
    expect(controlOperation).not.toHaveBeenCalled();

    const closeOperation = vi.fn();
    await registry.close(key, async () => {
      closeOperation();
      return true;
    });
    expect(closeOperation).toHaveBeenCalledOnce();
    await expect(
      registry.run(key, controlOperation, { weight: 0, waitForCapacity: true }),
    ).resolves.toBeUndefined();
    expect(controlOperation).toHaveBeenCalledOnce();
  });
  it("keeps transcript admission sealed while explicit close follows skipped recovery", async () => {
    const registry = createVoiceTranscriptOperationRegistry(VOICE_TRANSCRIPT_QUEUE_POLICY);
    const recoveryGate = createDeferred<boolean>();
    const explicitGate = createDeferred<boolean>();
    const key = "agent\0voice-recovery";
    const recovery = registry.close(key, () => recoveryGate.promise, true);
    const explicitOperation = vi.fn(() => explicitGate.promise);
    const explicit = registry.close(key, explicitOperation);
    try {
      recoveryGate.resolve(false);
      await recovery;
      await expect(registry.run(key, async () => "late transcript")).rejects.toThrow(
        "voice transcript persistence session is closing",
      );
      expect(explicitOperation).toHaveBeenCalledOnce();
    } finally {
      recoveryGate.resolve(false);
      explicitGate.resolve(true);
      await Promise.all([recovery, explicit]);
    }
    expect(await explicit).toBe(true);
  });
});
