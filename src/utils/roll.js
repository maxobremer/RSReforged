import { MODULE_NAME, MODULE_SHORT, ROLL_TYPE } from "../module/const.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

export const KEYBIND_VERSATILE_TWO_HANDED = "versatileTwoHanded";

/**
 * Activity types whose dnd5e follow-up rolls (Activity#_triggerSubsequentActions) RSR performs
 * itself onto the usage card.
 */
const ROLLING_ACTIVITY_TYPES = new Set(["attack", "damage", "heal", "save", "utility"]);

// ROLL_TYPE is defined in const.js (so settings.js can use it without an import
// cycle) but re-exported here to preserve the established import path.
export { ROLL_TYPE };

/**
 * Enumerable of identifiers for roll states (advantage or disadvantage).
 * @enum {String}
 */
export const ROLL_STATE = {
    ADV: "kh",
    DIS: "kl",
    DUAL: "dual",
    SINGLE: "single"
}

/**
 * Enumerable of identifiers for crit result types.
 * @enum {String}
 */
export const CRIT_TYPE = {
    MIXED: "mixed",
    SUCCESS: "success",
    FAILURE: "failure"
}

/**
 * Utility class for functions related to making specific rolls.
 */
export class RollUtility {
    static processRoll(config, dialog, message) {
        // dnd5e 6.0 builds check/save message data as `{ flavor, speaker, system, type }`
        // (actor.mjs rollSkillTool / #rollD20Test) and no longer pre-seeds `data.flags`, so
        // the namespace has to be created before RSR writes into it.
        const flags = RollUtility.ensureMessageFlags(message);
        if (!flags) return;
        if (flags[MODULE_SHORT]?.processed) return;

        const keys = RollUtility.readRollKeys(config.event);

        // dnd5e 6 port: fast-forward by default, the dnd5e "skip dialog" key (Shift) asks for the
        // configuration dialog instead. An explicit `dialog.configure` from the caller (a macro,
        // AC5e, other modules, ...) always wins.
        if (dialog.configure === undefined) dialog.configure = keys.normal || !!config.vanilla;

        if (config.isConcentration) {
            config.flavor = `${CoreUtility.localize("DND5E.ToolPromptTitle", { tool: CoreUtility.localize("DND5E.Concentration") })}`;
        }

        flags[MODULE_SHORT] = {
            quickRoll: !dialog.configure,
            advantage: keys.advantage,
            disadvantage: keys.disadvantage,
            isConcentration: config.isConcentration,
            processed: true
        };
    }

    /**
     * Read the dnd5e roll modifier keys from an event, falling back to the live keyboard
     * state when there is no event (hotbar macros, programmatic rolls from a click handler).
     * `normal` is the dnd5e "Skip Dialog" binding (Shift by default), which this fork uses as
     * the "show the configuration dialog" key.
     * @param {Event} [event]
     * @returns {{normal: boolean, advantage: boolean, disadvantage: boolean}}
     */
    static readRollKeys(event) {
        if (event) return _readSkipDialogKeys(event);
        const held = action => {
            try {
                return game.keybindings.get("dnd5e", action).some(b => game.keyboard.downKeys.has(b.key)
                    && b.modifiers.every(m => game.keyboard.isModifierActive(m)));
            } catch (err) {
                return false;
            }
        };
        return {
            normal: held("skipDialogNormal"),
            advantage: held("skipDialogAdvantage"),
            disadvantage: held("skipDialogDisadvantage")
        };
    }

    /**
     * Whether a roll going through dnd5e's pipeline should show its configuration dialog under
     * the fork's inverted rule (fast-forward unless the "Skip Dialog" key, Shift, is held).
     * @param {Event} [event]
     * @returns {boolean}
     */
    static wantsConfigure(event) {
        return RollUtility.readRollKeys(event).normal;
    }

    static processActivity(activity, usageConfig, dialogConfig, messageConfig) {
        // RSR always drives the follow-up rolls (attack, damage, healing, formula) itself and
        // puts them on the usage card, in quick AND configure mode, so dnd5e must never
        // trigger its own. Done FIRST, before anything below that could throw: dnd5e calls
        // this hook with Hooks.call, which swallows listener errors and carries on with the
        // activation, and a throw here would otherwise double every roll. Only for the
        // activity types whose follow-ups RSR replaces: enchant (self), transform, etc. keep
        // dnd5e's own subsequent actions.
        if (ROLLING_ACTIVITY_TYPES.has(activity?.type)) usageConfig.subsequentActions = false;

        const keys = RollUtility.readRollKeys(usageConfig.event);

        // Configure mode: Shift held (dnd5e "Skip Dialog" key, inverted in this fork), or
        // Item#use was Shift-clicked on a multi-activity item (see HooksUtility item wrapper).
        const configure = !!usageConfig.rsrConfigure || keys.normal || !!usageConfig.vanilla;
        delete usageConfig.rsrConfigure;

        // Preserve dnd5e's usage dialog for leveled spells so the player can
        // choose an upcast slot; cantrips skip it and use automatic scaling.
        // Note: dnd5e seeds usageConfig.scaling = 0 for any scalable activity
        // (including cantrips), so it isn't a reliable "user wants the dialog"
        // signal — the item-level check below is.
        const isLeveledSpell = activity?.item?.type === "spell"
            && (activity.item.system?.level ?? 0) > 0;
        // Preserve OrderActivity dialogs because they populate costs/craft/trade
        // flags that dnd5e later expects during bastion order resolution.
        const isOrderActivity = activity?.type === "order";
        // Summon / transform profiles and enchantment choices are picked in the usage dialog.
        const choosesInDialog = ["summon", "transform", "enchant"].includes(activity?.type);
        // Smite-like features (Divine Smite et al.) need the dialog so the player can
        // pick which slot to spend (a spellSlots-typed consumption target).
        const consumesSpellSlot = !!activity?.consumption?.targets?.some?.(t => t?.type === "spellSlots");
        // Lay on Hands-style features: consumption.scaling.allowed means the player must
        // choose how much of a resource to spend.
        const hasConsumptionScaling = !!activity?.consumption?.scaling?.allowed;
        // Nonzero scaling means an upcast delta has already been seeded (e.g.
        // drag-to-slot, macro). Preserve the dialog so the player can confirm or adjust.
        const hasUpcastScaling = (usageConfig.scaling ?? 0) > 0;

        if (configure) {
            // Shift-use: show dnd5e's usage dialog (when the activity has anything to configure).
            dialogConfig.configure = true;
        } else if (dialogConfig.configure !== false) {
            dialogConfig.configure = isLeveledSpell
                || isOrderActivity
                || choosesInDialog
                || consumesSpellSlot
                || hasConsumptionScaling
                || hasUpcastScaling;
        }

        const flagSeed = {
            quickRoll: true,
            configure,
            advantage: keys.advantage,
            disadvantage: keys.disadvantage,
            processed: false
        };

        // Versatile shortcut. On a quick-roll click of a Versatile weapon, stamp
        // attackMode explicitly so dnd5e doesn't fall back to whatever it last
        // persisted on the item. Holding the rsreforged.versatileTwoHanded key
        // (KeyV by default) flips this roll to twoHanded; releasing it falls back to
        // oneHanded. In configure mode dnd5e's attack dialog offers the attack mode.
        if (!configure && activity?.item?.system?.isVersatile) {
            const versatileHeld = !!usageConfig.event && CoreUtility.areKeysPressed(
                usageConfig.event,
                KEYBIND_VERSATILE_TWO_HANDED,
                MODULE_NAME
            );
            flagSeed.attackMode = versatileHeld ? "twoHanded" : "oneHanded";
            flagSeed.versatile = versatileHeld;
        }

        // dnd5e 6.0 seeds activity usage message data as
        // `{ system: { targets } }` (activity/mixin.mjs Activity#use) — no `flags` key.
        const flags = RollUtility.ensureMessageFlags(messageConfig);
        if (flags) flags[MODULE_SHORT] = flagSeed;
    }

    /**
     * Return the (created if missing) `data.flags` object of a dnd5e roll/usage message
     * configuration. dnd5e 6.0 no longer pre-seeds `data.flags` anywhere, so every writer
     * must go through this. Returns null for a missing configuration.
     * @param {object} messageConfig A dnd5e BasicRollMessageConfiguration / ActivityMessageConfiguration.
     * @returns {object|null}
     */
    static ensureMessageFlags(messageConfig) {
        if (!messageConfig || typeof messageConfig !== "object") return null;
        messageConfig.data ??= {};
        messageConfig.data.flags ??= {};
        return messageConfig.data.flags;
    }

    /**
     * Register the "kf" (keep first) die modifier used by RSR's multiroll. A normal-mode d20
     * roll is evaluated as `2d20kf`: both dice are rolled (and animated) up-front so the roll
     * can later be switched to advantage/disadvantage without rolling again, while the total
     * keeps the FIRST die exactly like a single d20 would.
     */
    static registerDiceModifiers() {
        const D20Die = CONFIG.Dice?.D20Die;
        if (!D20Die) return;
        if (!Object.hasOwn(D20Die, "MODIFIERS")) D20Die.MODIFIERS = { ...D20Die.MODIFIERS };
        D20Die.MODIFIERS.kf = "rsrKeepFirst";
        D20Die.prototype.rsrKeepFirst = function (modifier) {
            const count = parseInt(String(modifier).match(/\d+/)?.[0] ?? "1") || 1;
            let kept = 0;
            for (const result of this.results) {
                if (!result.active || result.rerolled) continue;
                if (kept < count) kept += 1;
                else {
                    result.active = false;
                    result.discarded = true;
                }
            }
        };
    }

    /**
     * dnd5e.postRollConfiguration: turn every normal-mode d20 roll into a two-die "keep first"
     * roll so advantage/disadvantage can be applied retroactively (RSR multiroll).
     * @param {Roll[]} rolls Constructed, unevaluated rolls.
     * @param {object} config The roll process configuration.
     */
    static applyMultiRoll(rolls, config) {
        if (!SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL)) return;
        const hookNames = config?.hookNames ?? [];
        if (hookNames.includes("initiativeDialog") || hookNames.includes("initiative")) return;
        const D20Roll = CONFIG.Dice.D20Roll;
        for (const roll of rolls ?? []) {
            if (!(roll instanceof D20Roll) || roll._evaluated || !roll.validD20Roll) continue;
            const d20 = roll.d20;
            if (d20.number !== 1) continue;
            if (d20.modifiers.some(m => /^(adv|dis|kh|kl|kf|dh|dl)/i.test(m))) continue;
            const mode = roll.options?.advantageMode;
            if (mode !== undefined && mode !== D20Roll.ADV_MODE.NORMAL) continue;
            d20.number = 2;
            d20.modifiers.push("kf");
            roll.options.rsrMulti = true;
            roll.resetFormula();
        }
    }

    /**
     * The leading d20 term of a d20 roll (live or deserialized), or null.
     * @param {Roll} roll
     * @returns {DiceTerm|null}
     */
    static getD20Term(roll) {
        const term = roll?.terms?.[0];
        return (term && term.faces === 20 && Array.isArray(term.results)) ? term : null;
    }

    /**
     * The d20 results that are candidates for selection (every die rolled, minus results that
     * a reroll modifier such as Halfling Lucky replaced).
     * @param {DiceTerm} d20
     * @returns {object[]}
     */
    static getD20Candidates(d20) {
        return (d20?.results ?? []).filter(r => !r.rerolled);
    }

    /**
     * The current advantage mode of a d20 roll as "adv" | "dis" | "normal".
     * @param {Roll} roll
     * @returns {string}
     */
    static getD20Mode(roll) {
        const ADV = CONFIG.Dice.D20Roll.ADV_MODE;
        const mode = roll?.options?.advantageMode;
        if (mode === ADV.ADVANTAGE) return "adv";
        if (mode === ADV.DISADVANTAGE) return "dis";
        const modifiers = RollUtility.getD20Term(roll)?.modifiers ?? [];
        if (modifiers.some(m => /^(adv|kh)/i.test(m))) return "adv";
        if (modifiers.some(m => /^(dis|kl)/i.test(m))) return "dis";
        return "normal";
    }

    /**
     * Re-select which of the already-rolled d20s counts, without rolling anything:
     * normal keeps the first die, advantage the highest, disadvantage the lowest.
     * Updates modifiers, advantage options and the cached total.
     * @param {Roll} roll A d20 roll.
     * @param {string} [mode] "adv" | "dis" | "normal" (defaults to the roll's current mode).
     * @returns {boolean} Whether the roll was changed.
     */
    static applyD20Selection(roll, mode = RollUtility.getD20Mode(roll)) {
        const d20 = RollUtility.getD20Term(roll);
        if (!d20) return false;
        const candidates = RollUtility.getD20Candidates(d20);
        if (!candidates.length) return false;

        let kept = candidates[0];
        if (mode === "adv") kept = candidates.reduce((best, r) => (r.result > best.result ? r : best), candidates[0]);
        else if (mode === "dis") kept = candidates.reduce((best, r) => (r.result < best.result ? r : best), candidates[0]);

        for (const result of candidates) {
            const keep = result === kept;
            result.active = keep;
            result.discarded = !keep;
        }

        d20.modifiers = (d20.modifiers ?? []).filter(m => !/^(adv|dis|kh|kl|kf|dh|dl)\d*$/i.test(m) && !/^k\d*$/i.test(m));
        if (candidates.length > 1) d20.modifiers.push(mode === "adv" ? "kh" : mode === "dis" ? "kl" : "kf");
        d20.number = candidates.length;
        if (d20.options?.pending?.advantage) delete d20.options.pending.advantage;

        const ADV = CONFIG.Dice.D20Roll.ADV_MODE;
        const advantageMode = mode === "adv" ? ADV.ADVANTAGE : mode === "dis" ? ADV.DISADVANTAGE : ADV.NORMAL;
        roll.options ??= {};
        roll.options.advantageMode = advantageMode;
        roll.options.advantage = mode === "adv";
        roll.options.disadvantage = mode === "dis";
        d20.options ??= {};
        d20.options.advantageMode = advantageMode;

        RollUtility.resetRollGetters(roll);
        return true;
    }

    /**
     * Retroactively switch a d20 roll to advantage / disadvantage / normal, using the second
     * d20 already rolled by multiroll. Rolls the missing die (or dice, for Elven Accuracy) only
     * when the roll was made with a single d20.
     * @param {Roll} roll A d20 roll (mutated in place).
     * @param {string} mode "adv" | "dis" | "normal".
     * @returns {Promise<Roll|null>}
     */
    static async setD20Mode(roll, mode) {
        if (!roll) {
            LogUtility.logError(CoreUtility.localize(`${MODULE_SHORT}.messages.error.rollIsNullOrUndefined`));
            return null;
        }
        const d20 = RollUtility.getD20Term(roll);
        if (!d20) return null;

        const wanted = (mode === "adv" && roll.options?.elvenAccuracy) ? 3 : 2;
        const missing = mode === "normal" ? 0 : wanted - RollUtility.getD20Candidates(d20).length;
        if (missing > 0) {
            const extra = await new Roll(`${missing}d20`).evaluate();
            await CoreUtility.tryRollDice3D(extra);
            for (const result of extra.dice[0].results) d20.results.push({ result: result.result, active: true });
        }

        RollUtility.applyD20Selection(roll, mode);
        return roll;
    }

    static resetRollGetters(roll) {
        roll._total = roll._evaluateTotal();
        roll.resetFormula();
    }

    /**
     * Processes a set of dice results to check what type of critical was rolled (for showing colour in chat card).
     * @param {Die} die A die term to process into a crit type.
     * @param {Number} options.critThreshold The threshold above which a result is considered a crit.
     * @param {Number} options.fumbleThreshold The threshold below which a result is considered a crit.
     * @returns {CRIT_TYPE} The type of crit for the die term.
     */
    static getCritTypeForDie(die, options = {}) {
        if (!die) return null;

        const { crit, fumble } = _countCritsFumbles(die, options)

        return _getCritResult(crit, fumble);
    }

    /**
     * Checks if a roll (live instance or serialised flag data) is of a given roll class.
     * Serialised rolls carry the class name in `.class`; live rolls match via instanceof
     * or, for cross-realm/test instances, the constructor name.
     * @param {Roll|object} roll The roll or serialised roll data to test.
     * @param {typeof Roll} rollClass The roll class to test against.
     * @returns {Boolean} Whether the roll is of the given class.
     */
    static isRollOfType(roll, rollClass) {
        if (!roll || !rollClass) return false;
        // dnd5e's D20Roll and DamageRoll both extend BasicRoll, so an instanceof test would
        // treat attack and damage rolls as formula rolls (and mergeRollsByType would evict
        // them when a formula roll is merged). BasicRoll therefore matches its class exactly.
        if (rollClass === CONFIG.Dice?.BasicRoll) {
            return roll.constructor === rollClass || roll.class === rollClass.name;
        }
        return roll instanceof rollClass || roll.class === rollClass.name || roll.constructor?.name === rollClass.name;
    }

    /**
     * Merge a set of new rolls into an existing roll array, replacing any rolls of the
     * same class (at their original position) so that re-rolls replace rather than
     * duplicate the previous result. When there is nothing to merge, the existing rolls
     * are kept untouched — same-type entries are never evicted without a replacement
     * (e.g. a child message whose rolls failed to deserialize).
     * @param {Roll[]|object[]} existingRolls Current serialised or live roll array.
     * @param {Roll[]} newRolls Fresh rolls to merge in.
     * @param {typeof Roll} cleanType Roll class whose existing entries to replace.
     * @returns {Roll[]|object[]} The merged roll array.
     */
    static mergeRollsByType(existingRolls, newRolls, cleanType) {
        const existing = Array.from(existingRolls ?? []);
        const fresh = CoreUtility.isIterable(newRolls) ? Array.from(newRolls) : [];

        if (fresh.length === 0) return existing;
        if (!cleanType) return [...existing, ...fresh];

        const merged = [];
        let inserted = false;

        for (const roll of existing) {
            if (RollUtility.isRollOfType(roll, cleanType)) {
                if (!inserted) {
                    merged.push(...fresh);
                    inserted = true;
                }
                continue;
            }
            merged.push(roll);
        }

        if (!inserted) merged.push(...fresh);
        return merged;
    }
}

function _readSkipDialogKeys(event) {
    return {
        normal: CoreUtility.areKeysPressed(event, "skipDialogNormal"),
        advantage: CoreUtility.areKeysPressed(event, "skipDialogAdvantage"),
        disadvantage: CoreUtility.areKeysPressed(event, "skipDialogDisadvantage")
    };
}

function _getCritResult(crit, fumble)
{
    if (crit > 0 && fumble > 0) {
        return CRIT_TYPE.MIXED;
    }
    
    if (crit > 0) {
        return CRIT_TYPE.SUCCESS;
    }
    
    if (fumble > 0) {
        return CRIT_TYPE.FAILURE;
    }
}

function _countCritsFumbles(die, options)
{
    let crit = 0;
    let fumble = 0;

    if (die && die.faces > 1) {
        let { critThreshold, fumbleThreshold, target, ignoreDiscarded, displayChallenge, forceSuccess } = options

        if (forceSuccess) {
            return { crit: 1, fumble: 0 };
        }

        critThreshold = critThreshold ?? die.options.criticalSuccess ?? die.faces;
        fumbleThreshold = fumbleThreshold ?? die.options.criticalFailure ?? 1;

        for (const result of die.results) {
            if (result.rerolled || (result.discarded && ignoreDiscarded)) {
                continue;
            }
            
            if ((displayChallenge && result.result >= target) || result.result >= critThreshold) {
                crit += 1;
            } else if ((displayChallenge && result.result < target) || result.result <= fumbleThreshold) {
                fumble += 1;
            }
        }
    }

    return { crit, fumble }
}
