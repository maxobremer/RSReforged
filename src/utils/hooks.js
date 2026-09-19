import { RerollManager } from "./reroll.js";
import { MODULE_NAME, MODULE_SHORT, MODULE_TITLE } from "../module/const.js";
import { ActivityUtility } from "./activity.js";
import { ChatUtility } from "./chat.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { PrivacyUtility } from "./privacy.js";
import { KEYBIND_VERSATILE_TWO_HANDED, ROLL_TYPE, RollUtility } from "./roll.js";
import {
    DAMAGE_APPLY_MODES, FORK_MIGRATION_VERSION, HIDE_NPC_ROLL_MODES, SETTING_NAMES, SettingsUtility
} from "./settings.js";
import { TrayUtility } from "./tray.js";

export const HOOKS_CORE = { INIT: "init", SETUP: "setup", READY: "ready" }

export const HOOKS_DND5E = {
    PRE_ROLL_ABILITY_CHECK: "dnd5e.preRollAbilityCheck",
    PRE_ROLL_SAVING_THROW: "dnd5e.preRollSavingThrow",
    PRE_ROLL_SKILL: "dnd5e.preRollSkill",
    PRE_ROLL_TOOL_CHECK: "dnd5e.preRollTool",
    // Generic hook dnd5e fires LAST for every roll built through BasicRoll.buildConfigure
    // (config.hookNames always ends with "" -> "dnd5e.preRollV2").
    PRE_ROLL_V2: "dnd5e.preRollV2",
    POST_ROLL_CONFIGURATION: "dnd5e.postRollConfiguration",
    PRE_USE_ACTIVITY: "dnd5e.preUseActivity",
    ACTIVITY_CONSUMPTION: "dnd5e.activityConsumption",
    RENDER_CHAT_MESSAGE: "dnd5e.renderChatMessage"
}

export const HOOKS_INTEGRATION = { DSN_ROLL_COMPLETE: "diceSoNiceRollComplete" }

/**
 * dnd5e 6 message types whose rolls RSR folds into an RSR usage card when they are created
 * with that card as `system.origin` (e.g. a native card button, or another module calling
 * activity.rollDamage for the card).
 */
const MERGEABLE_CHILD_TYPES = ["attack", "damage", "healing", "generic"];

export class HooksUtility {
    static registerModuleHooks() {
        Hooks.once(HOOKS_CORE.INIT, () => {
            LogUtility.log(`Initialising ${MODULE_TITLE}`);
            SettingsUtility.registerSettings();
            HooksUtility.registerKeybindings();
            HooksUtility.registerRollHooks();
            HooksUtility.registerChatHooks();
            RerollManager.registerGlobalListener();
        });

        Hooks.once(HOOKS_CORE.SETUP, () => {
            RollUtility.registerDiceModifiers();
            TrayUtility.patchDamageApplication();
            HooksUtility.wrapItemUse();
        });

        Hooks.once(HOOKS_CORE.READY, async () => {
            CONFIG[MODULE_SHORT].combinedDamageTypes = foundry.utils.mergeObject(
                Object.fromEntries(Object.entries(CONFIG.DND5E.damageTypes).map(([k, v]) => [k, v.label])),
                Object.fromEntries(Object.entries(CONFIG.DND5E.healingTypes).map(([k, v]) => [k, v.label])),
                { recursive: false }
            );
            CONFIG.DND5E.aggregateDamageDisplay = SettingsUtility.getSettingValue(SETTING_NAMES.AGGREGATE_DAMAGE) ?? true;
            await _migrateHideNpcRollSetting().catch(err => LogUtility.logError(`Failed to migrate hide NPC roll setting: ${err}`));
            await _migrateForkSettings().catch(err => LogUtility.logError(`Failed to migrate RSReforged fork settings: ${err}`));
            HooksUtility.registerApi();
            LogUtility.log(`Loaded ${MODULE_TITLE}`);
        });
    }

    /**
     * Register RSReforged-namespaced keybindings. Must be called during `init`.
     * `versatileTwoHanded` defaults to KeyV and is read at click time via
     * `game.keyboard.downKeys`; the registration exists so it shows in Configure Controls.
     */
    static registerKeybindings() {
        LogUtility.log("Registering keybindings");

        game.keybindings.register(MODULE_NAME, KEYBIND_VERSATILE_TWO_HANDED, {
            name: CoreUtility.localize(`${MODULE_SHORT}.keybindings.versatileTwoHanded.name`),
            hint: CoreUtility.localize(`${MODULE_SHORT}.keybindings.versatileTwoHanded.hint`),
            editable: [{ key: "KeyV" }],
            restricted: false,
            precedence: CONST.KEYBINDING_PRECEDENCE.NORMAL
        });
    }

    static registerRollHooks() {
        LogUtility.log("Registering roll hooks");

        Hooks.on(HOOKS_DND5E.PRE_ROLL_ABILITY_CHECK, (config, dialog, message) => {
            // dnd5e fires preRollAbilityCheck for skill and tool checks too (their hookNames
            // chain is [type, "abilityCheck", "d20Test"]); each category has its own hook.
            if (config.hookNames?.some(n => n === "skill" || n === "tool")) return true;
            // The initiative dialog never creates a message of its own; the generic
            // PRE_ROLL_V2 handler still applies the fast-forward rule to it.
            if (config.hookNames?.includes("initiativeDialog")) return true;

            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_SAVING_THROW, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ABILITY_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_SKILL, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_SKILL_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_ROLL_TOOL_CHECK, (config, dialog, message) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_TOOL_ENABLED)) {
                RollUtility.processRoll(config, dialog, message);
            }
            return true;
        });

        // Fast-forward rule for every other roll that goes through dnd5e's pipeline (native
        // attack / damage / healing / formula buttons, hit dice, initiative, ...): skip the
        // configuration dialog unless the dnd5e "Skip Dialog" key (Shift) is held — the
        // inverse of dnd5e's default. dnd5e 6.0.3 has no built-in setting to swap this.
        // Ctrl/Alt keep their dnd5e meaning (disadvantage/advantage, or normal/critical for
        // damage) because D20Roll/DamageRoll.applyKeybindings still reads them afterwards.
        // Explicit `dialog.configure` values (RSR's own rolls, macros, AC5e, Codex GMC) win.
        Hooks.on(HOOKS_DND5E.PRE_ROLL_V2, (config, dialog, message) => {
            if (!dialog || dialog.configure !== undefined) return true;
            if (!SettingsUtility.fastForwardAppliesTo(config?.hookNames ?? [])) return true;
            dialog.configure = RollUtility.wantsConfigure(config?.event);
            LogUtility.debug("fast-forward", config?.hookNames, { configure: dialog.configure });
            return true;
        });

        Hooks.on(HOOKS_DND5E.PRE_USE_ACTIVITY, (activity, usageConfig, dialogConfig, messageConfig) => {
            if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) {
                RollUtility.processActivity(activity, usageConfig, dialogConfig, messageConfig);
            }
            return true;
        });

        // The last configuration hook dnd5e fires before a roll is evaluated (after any
        // dialog). Two jobs, both must never return false (that vetoes the roll):
        //  - capture the pending message configuration of RSR's own rolls (targets adjusted
        //    by cover / condition modules, issue #38);
        //  - multiroll: make normal-mode d20 rolls "2d20kf" so advantage/disadvantage can be
        //    applied afterwards without rolling again.
        Hooks.on(HOOKS_DND5E.POST_ROLL_CONFIGURATION, (rolls, config, dialog, message) => {
            ActivityUtility.captureRollMessageConfig(message);
            try {
                RollUtility.applyMultiRoll(rolls, config);
            } catch (err) {
                console.error("RSReforged | multiroll setup failed", err);
            }
        });

        // dnd5e 5.3.0+: ActivityUsageUpdates always uses `updates.item`.
        Hooks.on(HOOKS_DND5E.ACTIVITY_CONSUMPTION, (activity, usageConfig, messageConfig, updates) => {
            if (!SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) return;

            // processActivity seeds this namespace during preUseActivity. dnd5e's later
            // chat-card "Consume Resource" action invokes this hook with an empty
            // messageConfig and no rollAttack follows, so it must be left alone.
            const moduleFlags = messageConfig.data?.flags?.[MODULE_SHORT];
            if (!moduleFlags) return;

            const hasAttack = activity.type === "attack" || !!activity.attack || activity.hasOwnProperty(ROLL_TYPE.ATTACK);
            const items = updates.item;

            if (hasAttack && items && items.length > 0) {
                const ammo = items.find(i => i["system.quantity"] !== undefined || i["system.uses.spent"] !== undefined);
                if (!ammo) return;

                moduleFlags.ammunition = ammo._id;

                // Add back the single unit that dnd5e's rollAttack will itself decrement, but
                // only for a weapon-ammunition option (issue #34).
                if (ammo["system.quantity"] !== undefined) {
                    const isWeaponAmmo = activity.item?.system?.ammunitionOptions?.some(o => o.value === ammo._id);
                    if (isWeaponAmmo) ammo["system.quantity"]++;
                }
            }
        });
    }

    static registerChatHooks() {
        LogUtility.log("Registering chat hooks");

        Hooks.on("preCreateChatMessage", (message, data, options, userId) => {
            if (userId !== game.user.id) return;

            // Forward-compat hygiene: rewrite legacy `Die` terms to V14's canonical BasicDie.
            if (message.rolls?.length) {
                let changed = false;
                const patched = CoreUtility.serializeRolls(message.rolls);
                for (const json of patched) {
                    for (const term of json.terms ?? []) {
                        if (term.class === "Die") {
                            term.class = "BasicDie";
                            changed = true;
                        }
                    }
                }
                if (changed) message.updateSource({ rolls: patched });
            }

            // A roll message whose origin is an RSR card: put the rolls on the card instead.
            if (HooksUtility._interceptChildRollMessage(message)) return false;

            const t = message.type;
            const isUsage = t === "usage"
                || t === "dnd5e.usage"
                || ((!t || t === "base") && (message.flags?.dnd5e?.messageType === "usage" || !!message.flags?.dnd5e?.use));

            if (isUsage && SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) {
                const flags = { ...(message.flags?.[MODULE_SHORT] || {}) };
                flags.quickRoll ??= true;
                flags.processed ??= false;

                const activity = ActivityUtility._getActivityFromMessage(message);

                if (activity) {
                    ActivityUtility.setRenderFlags(activity, flags);
                } else if (flags.quickRoll) {
                    LogUtility.logWarning("Could not resolve activity during preCreate; will retry at render.", { ui: false });
                }

                message.updateSource({ [`flags.${MODULE_SHORT}`]: flags });
            }
        });

        // dnd5e 6.0: every system-typed message re-renders `.message-content` from system data
        // in ChatMessage5e#renderHTML AFTER core's renderChatMessageHTML, then fires
        // dnd5e.renderChatMessage last — for every message and every (re-)render. All RSR DOM
        // work therefore happens here and is recomputed from message data each time.
        Hooks.on(HOOKS_DND5E.RENDER_CHAT_MESSAGE, (message, html) => {
            const element = html instanceof HTMLElement ? html : html?.[0];
            if (!message || !element) return;
            ChatUtility.processChatMessage(message, element).catch(err => {
                console.error("RSReforged | failed to process chat message", message?.id, err);
                element.classList.remove("rsr-hide");
            });
        });

        // A summarized child (save/check folded into a usage card) was revealed or its rolls
        // changed (retro advantage, bonus, reroll): dnd5e only refreshes the origin card for
        // `system` changes, so re-render it here on every client.
        Hooks.on("updateChatMessage", (message, changed) => {
            if (!("whisper" in changed) && !("blind" in changed) && !("rolls" in changed)) return;
            let origin = null;
            try { origin = message.system?.origin ?? null; } catch (err) { origin = null; }
            if (origin && origin !== message && origin.id) ui.chat?.updateMessage?.(origin);
        });
    }

    /**
     * Fold a new child roll message (native Attack / Damage / Healing / Formula button of an
     * RSR card, or a module rolling for the card) into its RSR origin card.
     * @param {ChatMessage} message The pending (pre-create) message.
     * @returns {boolean} Whether creation should be cancelled.
     */
    static _interceptChildRollMessage(message) {
        if (!MERGEABLE_CHILD_TYPES.includes(message.type)) return false;
        if (!SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) return false;
        if (message.flags?.[MODULE_SHORT]?.noMerge) return false;
        const originId = message._source?.system?.origin;
        if (!originId || typeof originId !== "string") return false;
        const origin = game.messages.get(originId);
        if (!ChatUtility.isRsrUsageCard(origin) || !origin.flags[MODULE_SHORT].processed) return false;
        if (!origin.canUserModify?.(game.user, "update")) return false;
        if (!message.rolls?.length) return false;

        LogUtility.debug("merging child roll message into card", message.type, origin.id);
        ChatUtility.mergeChildRollMessage(origin, message).catch(err => {
            console.error("RSReforged | failed to merge roll into card", err);
        });
        return true;
    }

    /**
     * dnd5e's Item#use skips the activity chooser when Shift is held (`!event?.shiftKey`).
     * Shift means "configure" in this fork, so for multi-activity items the chooser is shown
     * anyway and the configure request is carried to preUseActivity via `rsrConfigure`.
     */
    static wrapItemUse() {
        const proto = CONFIG.Item?.documentClass?.prototype;
        if (!proto || typeof proto.use !== "function" || proto._rsrUseWrapped) return;
        const original = proto.use;
        proto.use = function (config = {}, dialog = {}, message = {}) {
            try {
                const event = config?.event;
                if (event?.shiftKey
                    && SettingsUtility.getSettingValue(SETTING_NAMES.FAST_FORWARD_ROLLS)
                    && SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_ACTIVITY_ENABLED)) {
                    const usable = this.system?.activities?.filter?.(a => a.canUse) ?? [];
                    if (usable.length > 1 || config.chooseActivity) {
                        const shiftless = new Proxy(event, {
                            get(target, property) {
                                if (property === "shiftKey") return false;
                                const value = Reflect.get(target, property);
                                return typeof value === "function" ? value.bind(target) : value;
                            }
                        });
                        config = { ...config, event: shiftless, rsrConfigure: true };
                    }
                }
            } catch (err) {
                console.warn("RSReforged | Item#use wrapper failed, falling back", err);
            }
            return original.call(this, config, dialog, message);
        };
        proto._rsrUseWrapped = true;
    }

    /**
     * `game.modules.get("rsreforged").api` — small helpers for live testing.
     */
    static registerApi() {
        const module = game.modules.get(MODULE_NAME);
        if (!module) return;
        module.api = {
            reveal: message => PrivacyUtility.reveal(typeof message === "string" ? game.messages.get(message) : message),
            setD20Mode: async (messageId, rollIndex, mode) => ChatUtility.retroD20Mode(game.messages.get(messageId), rollIndex, mode, { confirm: false }),
            debug: {
                /** Turn console debug logging on/off (client setting). */
                enable: (on = true) => game.settings.set(MODULE_NAME, SETTING_NAMES.DEBUG, !!on),
                /** Current module settings. */
                settings: () => Object.fromEntries(Object.values(SETTING_NAMES)
                    .map(key => { try { return [key, game.settings.get(MODULE_NAME, key)]; } catch (err) { return [key, undefined]; } })),
                /** Summary of a message (default: the latest). */
                inspect: (messageId) => {
                    const message = messageId ? game.messages.get(messageId) : game.messages.contents.at(-1);
                    if (!message) return null;
                    const rolls = ChatUtility.getMessageRolls(message);
                    return {
                        id: message.id,
                        type: message.type,
                        rsrType: ChatUtility.getMessageType(message),
                        isRsrCard: ChatUtility.isRsrUsageCard(message),
                        flags: foundry.utils.deepClone(message.flags?.[MODULE_SHORT] ?? null),
                        whisper: message.whisper,
                        blind: message.blind,
                        visible: message.visible,
                        isContentVisible: message.isContentVisible,
                        rolls: rolls.map(r => ({
                            class: r.constructor?.name ?? r.class,
                            formula: r.formula,
                            total: r.total,
                            mode: RollUtility.getD20Term(r) ? RollUtility.getD20Mode(r) : undefined,
                            d20: RollUtility.getD20Term(r)?.results?.map(x => ({ ...x }))
                        })),
                        nativeRolls: message.rolls?.length ?? 0
                    };
                },
                trayPatched: () => !!customElements.get("damage-application")?.prototype?._rsrPatched,
                multirollModifier: () => !!CONFIG.Dice?.D20Die?.MODIFIERS?.kf,
                itemUseWrapped: () => !!CONFIG.Item?.documentClass?.prototype?._rsrUseWrapped
            }
        };
    }
}

async function _migrateHideNpcRollSetting() {
    // Both settings are world-scoped and only GMs may write those.
    if (!game.user.isGM) return;

    const legacyEnabled = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED);
    if (!legacyEnabled) return;

    const currentMode = SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_NPC_ROLL_MODE);
    if (currentMode === HIDE_NPC_ROLL_MODES.NONE) {
        await game.settings.set(MODULE_NAME, SETTING_NAMES.HIDE_NPC_ROLL_MODE, HIDE_NPC_ROLL_MODES.ATTACKS);
    }

    await game.settings.set(MODULE_NAME, SETTING_NAMES.HIDE_FINAL_RESULT_ENABLED, false);
}

/**
 * One-shot migrations for the GMC fork (5.0.0):
 *  - world (GM): the retired RSR apply-button mode "rsr" becomes the native tray, the retired
 *    "vanilla" master switch is cleared;
 *  - client: multiroll becomes the default (a stored `false` from the old default is reset
 *    once; the user may turn it off again afterwards).
 */
async function _migrateForkSettings() {
    if (game.user.isGM && SettingsUtility.getSettingValue(SETTING_NAMES.MIGRATION_VERSION) !== FORK_MIGRATION_VERSION) {
        if (SettingsUtility.getSettingValue(SETTING_NAMES.DAMAGE_APPLY_MODE) !== DAMAGE_APPLY_MODES.DND5E) {
            await game.settings.set(MODULE_NAME, SETTING_NAMES.DAMAGE_APPLY_MODE, DAMAGE_APPLY_MODES.DND5E);
        }
        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED)) {
            await game.settings.set(MODULE_NAME, SETTING_NAMES.QUICK_VANILLA_ENABLED, false);
        }
        await game.settings.set(MODULE_NAME, SETTING_NAMES.MIGRATION_VERSION, FORK_MIGRATION_VERSION);
        LogUtility.log(`Migrated world settings to fork ${FORK_MIGRATION_VERSION}`);
    }

    if (SettingsUtility.getSettingValue(SETTING_NAMES.CLIENT_MIGRATION_VERSION) !== FORK_MIGRATION_VERSION) {
        await game.settings.set(MODULE_NAME, SETTING_NAMES.ALWAYS_ROLL_MULTIROLL, true);
        await game.settings.set(MODULE_NAME, SETTING_NAMES.CLIENT_MIGRATION_VERSION, FORK_MIGRATION_VERSION);
    }
}
