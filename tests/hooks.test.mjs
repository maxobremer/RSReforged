import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    handlers: new Map(),
    settings: {
        enableActivityQuickRoll: true,
        enableAbilityQuickRoll: true,
        enableSkillQuickRoll: true,
        enableToolQuickRoll: true,
        enableVanillaQuickRoll: false,
        manualDamageMode: 0
    },
    logError: vi.fn(),
    processActivity: vi.fn(),
    processRoll: vi.fn()
}));

vi.mock("../src/utils/activity.js", () => ({
    ActivityUtility: {
        _getActivityFromMessage: vi.fn((message) => message._activity ?? null)
    }
}));

vi.mock("../src/utils/settings.js", () => ({
    SETTING_NAMES: {
        QUICK_ABILITY_ENABLED: "enableAbilityQuickRoll",
        QUICK_ACTIVITY_ENABLED: "enableActivityQuickRoll",
        QUICK_SKILL_ENABLED: "enableSkillQuickRoll",
        QUICK_TOOL_ENABLED: "enableToolQuickRoll",
        QUICK_VANILLA_ENABLED: "enableVanillaQuickRoll",
        MANUAL_DAMAGE_MODE: "manualDamageMode"
    },
    SettingsUtility: {
        getSettingValue: vi.fn((setting) => {
            if (Object.hasOwn(state.settings, setting)) return state.settings[setting];
            throw new Error(`Unexpected setting read: ${setting}`);
        })
    }
}));

vi.mock("../src/utils/log.js", () => ({
    LogUtility: {
        log: vi.fn(),
        logError: state.logError
    }
}));

vi.mock("../src/utils/bonus.js", () => ({ BonusManager: { init: vi.fn() } }));
vi.mock("../src/utils/chat.js", () => ({ ChatUtility: { processChatMessage: vi.fn() } }));
vi.mock("../src/utils/reroll.js", () => ({ RerollManager: { registerGlobalListener: vi.fn() } }));
vi.mock("../src/utils/roll.js", () => ({
    ROLL_TYPE: { ATTACK: "attack" },
    RollUtility: {
        processActivity: state.processActivity,
        processRoll: state.processRoll
    }
}));

const { MODULE_SHORT } = await import("../src/module/const.js");
const { HooksUtility } = await import("../src/utils/hooks.js");

function registerPreCreateHook() {
    globalThis.game = { user: { id: "user-1" } };
    globalThis.Hooks = {
        on: vi.fn((name, handler) => state.handlers.set(name, handler))
    };

    HooksUtility.registerChatHooks();
    return state.handlers.get("preCreateChatMessage");
}

function registerRollHooks() {
    state.handlers.clear();
    globalThis.Hooks = {
        on: vi.fn((name, handler) => state.handlers.set(name, handler))
    };

    HooksUtility.registerRollHooks();
    return state.handlers;
}

function usageMessage(flags = {}) {
    const updates = [];
    return {
        type: "usage",
        flags,
        updateSource: vi.fn((update) => updates.push(update)),
        _updates: updates
    };
}

describe("HooksUtility preCreateChatMessage quick-roll flags", () => {
    beforeEach(() => {
        state.handlers.clear();
        state.settings = {
            enableActivityQuickRoll: true,
            enableAbilityQuickRoll: true,
            enableSkillQuickRoll: true,
            enableToolQuickRoll: true,
            enableVanillaQuickRoll: false,
            manualDamageMode: 0
        };
        state.logError.mockClear();
        state.processActivity.mockClear();
        state.processRoll.mockClear();
    });

    it("honors the skill quick-roll setting at roll time", () => {
        const handlers = registerRollHooks();
        const preRollSkill = handlers.get("dnd5e.preRollSkillV2");
        const config = {};
        const dialog = { configure: true };
        const message = { data: { flags: {} } };

        state.settings.enableSkillQuickRoll = false;
        expect(preRollSkill(config, dialog, message)).toBe(true);
        expect(state.processRoll).not.toHaveBeenCalled();

        state.settings.enableSkillQuickRoll = true;
        expect(preRollSkill(config, dialog, message)).toBe(true);
        expect(state.processRoll).toHaveBeenCalledWith(config, dialog, message);
    });

    it("honors the activity quick-roll setting at use time", () => {
        const handlers = registerRollHooks();
        const preUseActivity = handlers.get("dnd5e.preUseActivity");
        const activity = {};
        const usageConfig = {};
        const dialogConfig = {};
        const messageConfig = { data: { flags: {} } };

        state.settings.enableActivityQuickRoll = false;
        expect(preUseActivity(activity, usageConfig, dialogConfig, messageConfig)).toBe(true);
        expect(state.processActivity).not.toHaveBeenCalled();

        state.settings.enableActivityQuickRoll = true;
        expect(preUseActivity(activity, usageConfig, dialogConfig, messageConfig)).toBe(true);
        expect(state.processActivity).toHaveBeenCalledWith(activity, usageConfig, dialogConfig, messageConfig);
        // The hook's contract is delegation: it routes PRE_USE_ACTIVITY into
        // processActivity when the setting is on. Side effects on usageConfig
        // (subsequentActions, dialogConfig.configure, MODULE_SHORT flags) belong
        // to processActivity and are exercised in roll.test.mjs against the real
        // implementation — asserting them here would lock in mock behavior.
    });

    it("preserves slow-roll flags written by the pre-use activity hook", () => {
        const preCreate = registerPreCreateHook();
        const message = usageMessage({
            [MODULE_SHORT]: {
                quickRoll: false,
                processed: true,
                advantage: true
            }
        });

        preCreate(message, {}, {}, "user-1");

        expect(message.updateSource).toHaveBeenCalledWith({
            [`flags.${MODULE_SHORT}`]: {
                quickRoll: false,
                processed: true,
                advantage: true
            }
        });
        expect(state.logError).not.toHaveBeenCalled();
    });

    it("adds render flags for quick-roll activity messages", () => {
        const preCreate = registerPreCreateHook();
        const message = usageMessage();
        message._activity = { type: "attack", hasOwnProperty: Object.prototype.hasOwnProperty };

        preCreate(message, {}, {}, "user-1");

        expect(message.updateSource).toHaveBeenCalledWith({
            [`flags.${MODULE_SHORT}`]: expect.objectContaining({
                quickRoll: true,
                processed: false,
                renderAttack: true,
                renderDamage: true
            })
        });
    });
});
