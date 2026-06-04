import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/chat.js", () => ({
    ChatUtility: { getActorFromMessage: vi.fn(() => ({ id: "actor1", items: { get: vi.fn((id) => id ? { id } : undefined) } })) }
}));
vi.mock("../src/utils/core.js", () => ({
    CoreUtility: {
        hasModule: vi.fn(() => false),
        tryRollDice3D: vi.fn(),
        playRollSound: vi.fn(),
        dice3dAnimatesRollUpdates: vi.fn(() => true),
        serializeRolls: vi.fn((rolls) => Array.from(rolls ?? []))
    }
}));
vi.mock("../src/utils/settings.js", () => ({
    SETTING_NAMES: {},
    SettingsUtility: { getSettingValue: vi.fn(() => false) }
}));
vi.mock("../src/utils/roll.js", () => ({
    ROLL_TYPE: { DAMAGE: "damage" },
    RollUtility: {
        isRollOfType: vi.fn(() => false),
        mergeRollsByType: vi.fn((existingRolls, newRolls) => [...(existingRolls ?? []), ...(newRolls ?? [])])
    }
}));
vi.mock("../src/module/const.js", () => ({ MODULE_SHORT: "rsr" }));
vi.mock("../src/module/integration.js", () => ({ MODULE_MIDI: "midi-qol" }));

const { ActivityUtility } = await import("../src/utils/activity.js");

describe("ActivityUtility.getDamageFromMessage", () => {
    let getActivitySpy;

    beforeEach(() => {
        getActivitySpy = vi.spyOn(ActivityUtility, "_getActivityFromMessage");
    });

    afterEach(() => {
        getActivitySpy.mockRestore();
    });

    // Regression: dnd5e 5.3 SaveActivity with no damage parts (e.g. Faerie Fire, Bane)
    // returns { rolls: [] } from getDamageConfig (base-activity.mjs:744). Calling
    // rollDamage on it crashes inside DamageRoll._evaluateASTAsync because the empty
    // rolls array reaches the roll builder. The guard in getDamageFromMessage must
    // short-circuit before rollDamage is invoked.
    it("returns null and does not call rollDamage when getDamageConfig has no rolls", () => {
        const rollDamage = vi.fn();
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: {} }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).toBeNull();
        expect(rollDamage).not.toHaveBeenCalled();
    });

    it("does not short-circuit when getDamageConfig reports at least one roll", () => {
        const rollDamage = vi.fn(() => Promise.resolve([]));
        const activity = {
            rollDamage,
            getDamageConfig: vi.fn(() => ({ rolls: [{ parts: ["1d6"] }] })),
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = { flags: { rsr: {} }, system: {} };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage).toHaveBeenCalledTimes(1);
    });

    // Regression: AttackActivity#getDamageConfig in dnd5e 5.3 only merges ammunition
    // damage when config.ammunition is supplied (see dnd5e attack-data.mjs ~line 290).
    // The guard MUST therefore evaluate getDamageConfig against the same resolved
    // config that rollDamage will receive — calling it with `{}` would suppress
    // ammo-driven attacks whose entire damage comes from the ammunition.
    it("passes the resolved config (including ammunition) to getDamageConfig", () => {
        const rollDamage = vi.fn(() => Promise.resolve([]));
        const getDamageConfig = vi.fn((config) => {
            // Empty when called bare, populated when ammo is present —
            // mirrors AttackActivity behaviour for an ammo-only weapon.
            if (config?.ammunition) return { rolls: [{ parts: ["1d6"], options: {} }] };
            return { rolls: [] };
        });
        const activity = {
            rollDamage,
            getDamageConfig,
            item: { flags: { dnd5e: {} } }
        };
        getActivitySpy.mockReturnValue(activity);

        const message = {
            flags: { rsr: { ammunition: "arrow-of-slaying" } },
            system: {}
        };
        const result = ActivityUtility.getDamageFromMessage(message);

        expect(result).not.toBeNull();
        expect(rollDamage).toHaveBeenCalledTimes(1);

        // The guard call should have received the resolved config, not `{}`.
        const guardCallConfig = getDamageConfig.mock.calls[0]?.[0];
        expect(guardCallConfig).toBeDefined();
        expect(guardCallConfig.ammunition).toBeDefined();
        expect(guardCallConfig.ammunition.id).toBe("arrow-of-slaying");
    });
});
