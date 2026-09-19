import { MODULE_NAME, MODULE_SHORT, ROLL_TYPE } from "../module/const.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";

/**
 * Enumerable of identifiers for setting names.
 * @enum {String}
 */
export const SETTING_NAMES = {
    QUICK_SKILL_ENABLED: "enableSkillQuickRoll",
    QUICK_ABILITY_ENABLED: "enableAbilityQuickRoll",
    QUICK_TOOL_ENABLED: "enableToolQuickRoll",
    QUICK_ACTIVITY_ENABLED: "enableActivityQuickRoll",
    QUICK_VANILLA_ENABLED: "enableVanillaQuickRoll",
    ALWAYS_ROLL_MULTIROLL: "alwaysRollMulti",
    D20_ICONS_ENABLED: "enableD20Icons",
    HIDE_FINAL_RESULT_ENABLED: "enableHideFinalResult",
    HIDE_NPC_ROLL_MODE: "hideNpcRollMode",
    HIDE_NPC_ROLL_STYLE: "hideNpcRollStyle",
    MANUAL_DAMAGE_MODE: "manualDamageMode",
    OVERLAY_BUTTONS_ENABLED: "enableOverlayButtons",
    DAMAGE_APPLY_MODE: "damageApplyMode",
    DAMAGE_BUTTONS_ENABLED: "enableDamageButtons",
    ALWAYS_SHOW_BUTTONS: "alwaysShowButtons",
    DICE_REROLL_ENABLED: "enableDiceReroll",
    AGGREGATE_DAMAGE: "aggregateDamage",
    APPLY_DAMAGE_TO: "applyDamageTo",
    CONFIRM_RETRO_ADV: "confirmRetroAdv",
    CONFIRM_RETRO_CRIT: "confirmRetroCrit",

    // Interactive dice (added in 4.0.0)
    REROLL_EVERYONE: "rerollEveryone",
    REROLL_PLAYERS: "rerollPlayers",
    FUDGE_GM: "fudgeGM",
    REROLL_SOUND_ENABLED: "rerollSoundEnabled",
    REROLL_LOG_CHAT: "rerollLogChat",

    // dnd5e 6 port
    FAST_FORWARD_ROLLS: "fastForwardRolls",
    HIDE_PRIVATE_ROLLS: "hidePrivateRolls",
    DEBUG: "debug",
    MIGRATION_VERSION: "forkMigration",
    CLIENT_MIGRATION_VERSION: "forkClientMigration"
}

/**
 * Current fork migration marker (see HooksUtility._migrateForkSettings).
 */
export const FORK_MIGRATION_VERSION = "5.0.0";

export const DAMAGE_APPLY_MODES = {
    DND5E: "dnd5e",
    RSR: "rsr"
}

export const HIDE_NPC_ROLL_MODES = {
    NONE: "none",
    ATTACKS: "attacks",
    ALL: "all"
}

export const HIDE_NPC_ROLL_STYLES = {
    // Mask the modified total (show "???") while revealing the natural d20. Original behavior.
    TOTAL: "total",
    // Reveal the modified total while masking the natural d20 value and all modifiers (issue #23).
    BREAKDOWN: "breakdown"
}

const D20_NPC_ROLL_TYPES = [
    ROLL_TYPE.ATTACK,
    ROLL_TYPE.SKILL,
    ROLL_TYPE.ABILITY_SAVE,
    ROLL_TYPE.ABILITY_TEST,
    ROLL_TYPE.DEATH_SAVE,
    ROLL_TYPE.TOOL,
    // dnd5e stamps concentration saves as type "save", but include the dedicated
    // type defensively in case a future system version stamps them directly.
    ROLL_TYPE.CONCENTRATION
];

/**
 * Utility class for registry of module settings and retrieval of setting data.
 */
export class SettingsUtility {
    /**
     * Registers all necessary module settings.
     */
    static registerSettings() {
        LogUtility.log("Registering module settings");

        // ROLL DIALOG BEHAVIOUR (dnd5e 6 port)
        game.settings.register(MODULE_NAME, SETTING_NAMES.FAST_FORWARD_ROLLS, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.FAST_FORWARD_ROLLS}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.FAST_FORWARD_ROLLS}.hint`),
            scope: "client",
            config: true,
            type: Boolean,
            default: true
        });

        // QUICK ROLL SETTINGS
        // QUICK_VANILLA_ENABLED is retired since the dnd5e 6 port (Shift-click now opens the dnd5e
        // dialogs while keeping the one-card result). It stays registered, hidden, so stored
        // values do not error; RSR ignores it.
        game.settings.register(MODULE_NAME, SETTING_NAMES.QUICK_VANILLA_ENABLED, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.QUICK_VANILLA_ENABLED}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.QUICK_VANILLA_ENABLED}.hint`),
            scope: "world",
            config: false,
            type: Boolean,
            default: false
        });

        const quickRollOptions = [
            { name: SETTING_NAMES.QUICK_ABILITY_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_SKILL_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_TOOL_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_ACTIVITY_ENABLED, default: true }
        ];

        quickRollOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: true,
                type: Boolean,
                default: option.default
            });
        });

        // ADDITIONAL ROLL SETTINGS
        // Multiroll is the default since the dnd5e 6 port; existing clients are migrated to true once
        // (HooksUtility._migrateForkSettings) and may switch it off again afterwards.
        game.settings.register(MODULE_NAME, SETTING_NAMES.ALWAYS_ROLL_MULTIROLL, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.ALWAYS_ROLL_MULTIROLL}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.ALWAYS_ROLL_MULTIROLL}.hint`),
            scope: "client",
            config: true,
            type: Boolean,
            default: true
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.MANUAL_DAMAGE_MODE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.MANUAL_DAMAGE_MODE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.MANUAL_DAMAGE_MODE}.hint`),
            scope: "client",
            config: true,
            type: Number,
            default: 0,
            choices: {
                0: CoreUtility.localize(`${MODULE_SHORT}.choices.manual.0`),
                1: CoreUtility.localize(`${MODULE_SHORT}.choices.manual.1`),
                2: CoreUtility.localize(`${MODULE_SHORT}.choices.manual.2`)
            }
        });

        // RETIRED (dnd5e 6 port): all damage is applied through dnd5e's native <damage-application>
        // tray now (with RSR's facelift, see tray.js). Kept registered and hidden so stored
        // world values load; the one-shot migration rewrites "rsr" to "dnd5e".
        game.settings.register(MODULE_NAME, SETTING_NAMES.DAMAGE_APPLY_MODE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_APPLY_MODE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_APPLY_MODE}.hint`),
            scope: "world",
            config: false,
            type: String,
            default: DAMAGE_APPLY_MODES.DND5E,
            choices: {
                [DAMAGE_APPLY_MODES.DND5E]: CoreUtility.localize(`${MODULE_SHORT}.choices.damageApplyMode.${DAMAGE_APPLY_MODES.DND5E}`),
                [DAMAGE_APPLY_MODES.RSR]: CoreUtility.localize(`${MODULE_SHORT}.choices.damageApplyMode.${DAMAGE_APPLY_MODES.RSR}`)
            }
        });

        const retiredWorldBooleans = [
            { name: SETTING_NAMES.DAMAGE_BUTTONS_ENABLED, default: true },
            { name: SETTING_NAMES.ALWAYS_SHOW_BUTTONS, default: true }
        ];
        retiredWorldBooleans.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: false,
                type: Boolean,
                default: option.default
            });
        });

        // CHAT CARD OPTIONS
        const chatCardOptions = [
            { name: SETTING_NAMES.AGGREGATE_DAMAGE, default: false, requiresReload: true },
            { name: SETTING_NAMES.D20_ICONS_ENABLED, default: true },
            { name: SETTING_NAMES.OVERLAY_BUTTONS_ENABLED, default: true },
            { name: SETTING_NAMES.CONFIRM_RETRO_ADV, default: false },
            { name: SETTING_NAMES.CONFIRM_RETRO_CRIT, default: false },
            { name: SETTING_NAMES.HIDE_PRIVATE_ROLLS, default: true }
        ];

        chatCardOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: true,
                type: Boolean,
                default: option.default,
                requiresReload: option.requiresReload ?? false,
                onChange: () => ui.chat?.render?.()
            });
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_MODE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_MODE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_MODE}.hint`),
            scope: "world",
            config: true,
            type: String,
            default: HIDE_NPC_ROLL_MODES.NONE,
            onChange: () => ui.chat?.render?.(),
            choices: {
                [HIDE_NPC_ROLL_MODES.NONE]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollMode.${HIDE_NPC_ROLL_MODES.NONE}`),
                [HIDE_NPC_ROLL_MODES.ATTACKS]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollMode.${HIDE_NPC_ROLL_MODES.ATTACKS}`),
                [HIDE_NPC_ROLL_MODES.ALL]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollMode.${HIDE_NPC_ROLL_MODES.ALL}`)
            }
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_STYLE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_STYLE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_NPC_ROLL_STYLE}.hint`),
            scope: "world",
            config: true,
            type: String,
            default: HIDE_NPC_ROLL_STYLES.TOTAL,
            onChange: () => ui.chat?.render?.(),
            choices: {
                [HIDE_NPC_ROLL_STYLES.TOTAL]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollStyle.${HIDE_NPC_ROLL_STYLES.TOTAL}`),
                [HIDE_NPC_ROLL_STYLES.BREAKDOWN]: CoreUtility.localize(`${MODULE_SHORT}.choices.hideNpcRollStyle.${HIDE_NPC_ROLL_STYLES.BREAKDOWN}`)
            }
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED, {
            // Preserve the old world setting key so existing worlds do not lose stored data.
            // New behavior is controlled by HIDE_NPC_ROLL_MODE.
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED}.hint`),
            scope: "world",
            config: false,
            type: Boolean,
            default: false,
            // Internal migration flag only — never shown in the UI and never affects
            // rendering directly, so it must not be reload-flagged. Otherwise the
            // one-shot migration write that clears it would pop Foundry's "reload
            // required" prompt on the first post-upgrade world load.
            requiresReload: false
        });
        
        // RETIRED (dnd5e 6 port): only RSR's classic apply buttons used this; the native tray has
        // its own selected/targeted toggle.
        game.settings.register(MODULE_NAME, SETTING_NAMES.APPLY_DAMAGE_TO, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.APPLY_DAMAGE_TO}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.APPLY_DAMAGE_TO}.hint`),
            scope: "world",
            config: false,
            type: Number,
            default: 0,
            choices: {
                0: CoreUtility.localize(`${MODULE_SHORT}.choices.apply.0`),
                1: CoreUtility.localize(`${MODULE_SHORT}.choices.apply.1`),
                2: CoreUtility.localize(`${MODULE_SHORT}.choices.apply.2`),
                3: CoreUtility.localize(`${MODULE_SHORT}.choices.apply.3`),
                4: CoreUtility.localize(`${MODULE_SHORT}.choices.apply.4`)
            }
        });

        // INTERACTIVE DICE OPTIONS (4.0.0+)
        const interactiveDiceOptions = [
            { name: SETTING_NAMES.REROLL_EVERYONE,      default: true },
            { name: SETTING_NAMES.REROLL_PLAYERS,       default: false },
            { name: SETTING_NAMES.FUDGE_GM,             default: false },
            { name: SETTING_NAMES.REROLL_SOUND_ENABLED, default: true },
            { name: SETTING_NAMES.REROLL_LOG_CHAT,      default: true }
        ];

        interactiveDiceOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: true,
                type: Boolean,
                default: option.default
            });
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.DEBUG, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DEBUG}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DEBUG}.hint`),
            scope: "client",
            config: true,
            type: Boolean,
            default: false
        });

        // Internal one-shot migration markers.
        game.settings.register(MODULE_NAME, SETTING_NAMES.MIGRATION_VERSION, {
            scope: "world", config: false, type: String, default: ""
        });
        game.settings.register(MODULE_NAME, SETTING_NAMES.CLIENT_MIGRATION_VERSION, {
            scope: "client", config: false, type: String, default: ""
        });
    }
    
    /**
     * Retrieve a specific setting value for the provided key.
     * @param {SETTING_NAMES|string} settingKey The identifier of the setting to retrieve.
     * @returns {string|boolean} The value of the setting as set for the world/client.
     */
    static getSettingValue(settingKey) {
        return game.settings.get(MODULE_NAME, settingKey);
    }

    /**
     * Whether the configured hide mode applies to the given roll type.
     * Damage and healing totals are never hidden.
     * @param {string} rollType
     * @returns {boolean}
     */
    static shouldHideNpcRollTotal(rollType) {
        let mode = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_NPC_ROLL_MODE);

        // Migration safety net: the legacy->mode migration is GM-only and runs at
        // ready, so in a freshly-upgraded world a non-GM client (or any client before
        // a GM has loaded) can render chat while mode is still the default "none" but
        // the legacy enableHideFinalResult flag is still set. Honor that flag as
        // attack-only hiding (its original behavior) until the migration clears it,
        // so NPC attack totals are not briefly exposed. Read-only — no write here.
        if (mode === HIDE_NPC_ROLL_MODES.NONE
            && SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED)) {
            mode = HIDE_NPC_ROLL_MODES.ATTACKS;
        }

        if (mode === HIDE_NPC_ROLL_MODES.NONE) return false;
        if (rollType === ROLL_TYPE.DAMAGE || rollType === ROLL_TYPE.HEALING) return false;
        if (mode === HIDE_NPC_ROLL_MODES.ATTACKS) return rollType === ROLL_TYPE.ATTACK;
        return D20_NPC_ROLL_TYPES.includes(rollType);
    }

    /**
     * Whether a roll total should be hidden for the viewing user.
     * GMs and actor owners always see full results. Unresolvable actors fail
     * closed: if ownership cannot be determined, the total is hidden from
     * non-GM users rather than leaked.
     * @param {Actor5e|null|undefined} actor
     * @param {string} rollType
     * @returns {boolean}
     */
    static shouldHideNpcRollForActor(actor, rollType) {
        if (!SettingsUtility.shouldHideNpcRollTotal(rollType)) return false;
        if (game.user.isGM) return false;
        return !actor?.isOwner;
    }

    /**
     * The configured presentation style for hidden NPC rolls.
     * "total" masks the modified total and shows the natural d20 (original behavior).
     * "breakdown" reveals the modified total and masks the d20 value + modifiers (issue #23).
     * @returns {string} One of HIDE_NPC_ROLL_STYLES.
     */
    static getHideNpcRollStyle() {
        return SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_NPC_ROLL_STYLE);
    }

    /**
     * Whether the fork's inverted dialog rule applies to a roll with the given dnd5e hook
     * names (fast-forward by default, Shift = configure). Gated by the client setting and by
     * the per-category quick roll toggles.
     * @param {string[]} [hookNames]
     * @returns {boolean}
     */
    static fastForwardAppliesTo(hookNames = []) {
        if (!SettingsUtility.getSettingValue(SETTING_NAMES.FAST_FORWARD_ROLLS)) return false;
        const has = name => hookNames.includes(name);
        if (has("skill")) return SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_SKILL_ENABLED);
        if (has("tool")) return SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_TOOL_ENABLED);
        if (has("abilityCheck") || has("savingThrow") || has("deathSave") || has("concentration")
            || has("initiativeDialog")) {
            return SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED);
        }
        return SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED);
    }

    static get debug() {
        try { return !!SettingsUtility.getSettingValue(SETTING_NAMES.DEBUG); } catch (err) { return false; }
    }
}
