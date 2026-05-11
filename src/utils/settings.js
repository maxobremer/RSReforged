import { MODULE_NAME, MODULE_SHORT } from "../module/const.js";
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
    MANUAL_DAMAGE_MODE: "manualDamageMode",
    OVERLAY_BUTTONS_ENABLED: "enableOverlayButtons",
    DAMAGE_APPLY_MODE: "damageApplyMode",
    DAMAGE_BUTTONS_ENABLED: "enableDamageButtons",
    ALWAYS_SHOW_BUTTONS: "alwaysShowButtons",
    DICE_REROLL_ENABLED: "enableDiceReroll",
    AGGREGATE_DAMAGE: "aggregateDamage",
    APPLY_DAMAGE_TO: "applyDamageTo",
    ALWAYS_ROLL_MULTIROLL: "alwaysRollMulti",
    CONFIRM_RETRO_ADV: "confirmRetroAdv",
    CONFIRM_RETRO_CRIT: "confirmRetroCrit",

    // Interactive dice (added in 4.0.0)
    REROLL_EVERYONE: "rerollEveryone",
    REROLL_PLAYERS: "rerollPlayers",
    FUDGE_GM: "fudgeGM"
}

export const DAMAGE_APPLY_MODES = {
    DND5E: "dnd5e",
    RSR: "rsr"
}

/**
 * Utility class for registry of module settings and retrieval of setting data.
 */
export class SettingsUtility {
    /**
     * Registers all necessary module settings.
     */
    static registerSettings() {
        LogUtility.log("Registering module settings");

        // QUICK ROLL SETTINGS        
		const quickRollOptions = [
            { name: SETTING_NAMES.QUICK_ABILITY_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_SKILL_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_TOOL_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_ACTIVITY_ENABLED, default: true },
            { name: SETTING_NAMES.QUICK_VANILLA_ENABLED, default: false }
        ];

        quickRollOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: true,
                type: Boolean,
                default: option.default,
                requiresReload: true
            });
        });

        // ADDITIONAL ROLL SETTINGS
        const extraRollOptions = [
            { name: SETTING_NAMES.ALWAYS_ROLL_MULTIROLL, default: false, scope: "client" }
        ];

        extraRollOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: option.scope,
                config: true,
                type: Boolean,
                default: option.default,
            });
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

        game.settings.register(MODULE_NAME, SETTING_NAMES.DAMAGE_APPLY_MODE, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_APPLY_MODE}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_APPLY_MODE}.hint`),
            scope: "world",
            config: true,
            type: String,
            default: DAMAGE_APPLY_MODES.RSR,
            requiresReload: true,
            choices: {
                [DAMAGE_APPLY_MODES.DND5E]: CoreUtility.localize(`${MODULE_SHORT}.choices.damageApplyMode.${DAMAGE_APPLY_MODES.DND5E}`),
                [DAMAGE_APPLY_MODES.RSR]: CoreUtility.localize(`${MODULE_SHORT}.choices.damageApplyMode.${DAMAGE_APPLY_MODES.RSR}`)
            }
        });

        game.settings.register(MODULE_NAME, SETTING_NAMES.DAMAGE_BUTTONS_ENABLED, {
            // Preserve the old world setting key so existing worlds do not lose stored data.
            // New behavior is controlled by DAMAGE_APPLY_MODE.
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_BUTTONS_ENABLED}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.DAMAGE_BUTTONS_ENABLED}.hint`),
            scope: "world",
            config: false,
            type: Boolean,
            default: true,
            requiresReload: true
        });

        // CHAT CARD OPTIONS
        const chatCardOptions = [
            { name: SETTING_NAMES.AGGREGATE_DAMAGE, default: false },
            { name: SETTING_NAMES.D20_ICONS_ENABLED, default: true },
            { name: SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED, default: false },
            //{ name: SETTING_NAMES.DICE_REROLL_ENABLED, default: true },
            { name: SETTING_NAMES.OVERLAY_BUTTONS_ENABLED, default: true },
            { name: SETTING_NAMES.ALWAYS_SHOW_BUTTONS, default: true },
            { name: SETTING_NAMES.CONFIRM_RETRO_ADV, default: false },
            { name: SETTING_NAMES.CONFIRM_RETRO_CRIT, default: false },
        ]        

        chatCardOptions.forEach(option => {
            game.settings.register(MODULE_NAME, option.name, {
                name: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.name`),
                hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${option.name}.hint`),
                scope: "world",
                config: true,
                type: Boolean,
                default: option.default,
                requiresReload: true
            });
        });
        
        game.settings.register(MODULE_NAME, SETTING_NAMES.APPLY_DAMAGE_TO, {
            name: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.APPLY_DAMAGE_TO}.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.settings.${SETTING_NAMES.APPLY_DAMAGE_TO}.hint`),
            scope: "world",
            config: true,
            type: Number,
            default: 0,
            requiresReload: true,
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
            { name: SETTING_NAMES.REROLL_EVERYONE, default: true },
            { name: SETTING_NAMES.REROLL_PLAYERS,  default: false },
            { name: SETTING_NAMES.FUDGE_GM,        default: false }
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
    }
    
    /**
     * Retrieve a specific setting value for the provided key.
     * @param {SETTING_NAMES|string} settingKey The identifier of the setting to retrieve.
     * @returns {string|boolean} The value of the setting as set for the world/client.
     */
    static getSettingValue(settingKey) {
        return game.settings.get(MODULE_NAME, settingKey);
    }

    static get _useRsrDamageApplyButtons() {
        return SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_APPLY_MODE) === DAMAGE_APPLY_MODES.RSR;
    }
    
    static get _applyDamageToTargeted() {
        const applyDamageOption = SettingsUtility.getSettingValue(SETTING_NAMES.APPLY_DAMAGE_TO);
        return applyDamageOption === 1 || applyDamageOption >= 2;
    }

    static get _applyDamageToSelected() {
        const applyDamageOption = SettingsUtility.getSettingValue(SETTING_NAMES.APPLY_DAMAGE_TO);
        return applyDamageOption === 0 || applyDamageOption >= 2;
    }

    static get _prioritiseDamageTargeted() {
        const applyDamageOption = SettingsUtility.getSettingValue(SETTING_NAMES.APPLY_DAMAGE_TO);
        return applyDamageOption === 4;
    }

    static  get _prioritiseDamageSelected() {
        const applyDamageOption = SettingsUtility.getSettingValue(SETTING_NAMES.APPLY_DAMAGE_TO);
        return applyDamageOption === 3;
    }
}
