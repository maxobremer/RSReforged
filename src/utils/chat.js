import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { ActivityUtility } from "./activity.js";
import { BonusManager } from "./bonus.js";
import { CoreUtility } from "./core.js";
import { DialogUtility } from "./dialog.js";
import { LogUtility } from "./log.js";
import { PrivacyUtility } from "./privacy.js";
import { ROLL_TYPE, RollUtility } from "./roll.js";
import { HIDE_NPC_ROLL_STYLES, SETTING_NAMES, SettingsUtility } from "./settings.js";

/**
 * Third-party integrations (WM5e, AC5e) were written against upstream RSR, which
 * passed jQuery objects to its render hooks. Keep that contract.
 */
function _jq(el) {
    const $ = globalThis.jQuery;
    if ( !$ || !el ) return el;
    return (el instanceof $) ? el : $(el);
}


export const MESSAGE_TYPE = {
    ROLL: "roll",
    USAGE: "usage",
}

/**
 * dnd5e 6 templates reused to render RSR's rolls in the system's compact chat style.
 */
const TEMPLATES = {
    ROLL_COMPACT: "systems/dnd5e/templates/chat/parts/roll-compact.hbs",
    ATTACK_CARD: "systems/dnd5e/templates/chat/attack-card.hbs",
    DAMAGE_CARD: "systems/dnd5e/templates/chat/damage-card.hbs",
    CARD_ROWS: "systems/dnd5e/templates/chat/parts/card-rows.hbs",
    CARD_ROLLS: "systems/dnd5e/templates/chat/parts/card-rolls.hbs"
};

/**
 * Native usage-card button actions that RSR handles itself on its cards (rolling onto the
 * card instead of spawning a separate roll message).
 */
const NATIVE_ROLL_ACTIONS = {
    rollAttack: ROLL_TYPE.ATTACK,
    rollDamage: ROLL_TYPE.DAMAGE,
    rollHealing: ROLL_TYPE.DAMAGE,
    rollFormula: ROLL_TYPE.FORMULA
};

/**
 * dnd5e 6 roll message types whose compact roll buttons RSR decorates (multiroll display,
 * hidden NPC totals, breakdown action buttons, die reroll paths).
 */
const DECORATED_TYPES = new Set(["attack", "damage", "healing", "check", "save", "generic"]);

export class ChatUtility {
    /**
     * The authoritative rolls of a message. RSR usage cards keep theirs in
     * `flags.rsreforged.rolls` (mirrored to `message.rolls`); every other message uses its
     * native rolls.
     * @param {ChatMessage} message
     * @returns {Roll[]}
     */
    static getMessageRolls(message) {
        const flagRolls = message?.flags?.[MODULE_SHORT]?.rolls;
        if (Array.isArray(flagRolls) && ChatUtility.getMessageType(message) === ROLL_TYPE.ACTIVITY) {
            return flagRolls.map(r => {
                if (r instanceof Roll) return r;
                try { return Roll.fromData(r); } catch (e) { return null; }
            }).filter(r => r);
        }
        return Array.from(message?.rolls || []);
    }

    /**
     * Whether a message is a usage card managed by RSR.
     * @param {ChatMessage} message
     * @returns {boolean}
     */
    static isRsrUsageCard(message) {
        return !!message && ChatUtility.getMessageType(message) === ROLL_TYPE.ACTIVITY && !!message.flags?.[MODULE_SHORT]?.quickRoll;
    }

    /**
     * Whether the current user may change a message's rolls (retro advantage, bonus, crit).
     * @param {ChatMessage} message
     * @returns {boolean}
     */
    static canModify(message) {
        return !!message && (game.user.isGM || message.isAuthor === true);
    }

    /**
     * Persist changed rolls: always the native `rolls`, plus RSR's flag copy on RSR cards.
     * @param {ChatMessage} message
     * @param {Roll[]} rolls
     * @param {object} [extra] Additional update data.
     */
    static async persistRolls(message, rolls, extra = {}) {
        // Re-open the breakdown popover the change was made from once the card re-renders.
        const candidate = message._rsrReopenCandidate;
        if (candidate && (Date.now() - candidate.at) < 120000) message._rsrReopen = candidate;
        delete message._rsrReopenCandidate;

        const serialized = CoreUtility.serializeRolls(rolls);
        const update = { ...extra, rolls: serialized };
        if (ChatUtility.isRsrUsageCard(message)) {
            message.flags[MODULE_SHORT].rolls = serialized;
            update.flags = message.flags;
        }
        await ChatUtility.updateChatMessage(message, update);
    }

    /**
     * Entry point from the dnd5e.renderChatMessage hook (every message, every render).
     * @param {ChatMessage5e} message
     * @param {HTMLElement} element The rendered message element.
     */
    static async processChatMessage(message, element) {
        if (!message || !element) return;
        if (!message.flags) message.flags = {};

        // Privacy first and synchronously: a private roll must never flash for other players.
        const hiddenFromUser = PrivacyUtility.applyToElement(message, element);

        const type = ChatUtility.getMessageType(message);
        const flags = message.flags[MODULE_SHORT];
        const isRsrCard = type === ROLL_TYPE.ACTIVITY && !!flags?.quickRoll;

        // The author rolls a pending card even when its content is hidden from them (blind).
        if (isRsrCard && !flags.processed) {
            element.classList.add("rsr-hide");
            if (message.isAuthor && !message._rsrIsProcessing) await _runPendingActions(message, element);
            return;
        }

        if (hiddenFromUser) return;
        PrivacyUtility.injectRevealButton(message, element);
        PrivacyUtility.processSummaries(element);

        // dnd5e hides child messages that its origin card summarizes.
        if (element.hidden) return;

        if (isRsrCard) {
            element.classList.add("rsr-hide");
            try {
                if (game.dice3d && game.dice3d.isEnabled() && message._dice3danimating) {
                    await game.dice3d.waitFor3DAnimationByMessageID(message.id);
                }
                await _renderUsageCard(message, element);
            } finally {
                element.classList.remove("rsr-hide");
            }
        }

        try {
            _decorateMessage(message, element);
        } catch (err) {
            console.error("RSReforged | failed to decorate rolls", err);
        }

        const content = element.querySelector(".message-content") ?? element;
        Hooks.callAll(`${MODULE_SHORT}.renderChatMessageContent`, message, _jq(content), type);

        if (isRsrCard) _scrollChatToBottom();
    }

    static async updateChatMessage(message, update = {}, context = {}) {
        if (!(message instanceof ChatMessage)) return;
        if (update.rolls && Array.isArray(update.rolls)) {
            update.rolls = CoreUtility.serializeRolls(update.rolls);
        }

        // dnd5e 6 reads a card's rolls from `message.rolls` (the native <damage-application>
        // tray, the attack->damage registry lookup). Keep the native rolls of RSR usage cards
        // in step with RSR's authoritative flag copy.
        const rsrFlags = update.flags?.[MODULE_SHORT];
        if (update.rolls === undefined && ChatUtility.getMessageType(message) === ROLL_TYPE.ACTIVITY
            && Array.isArray(rsrFlags?.rolls) && rsrFlags.processed) {
            update.rolls = CoreUtility.serializeRolls(rsrFlags.rolls);
        }

        Object.assign(update, ActivityUtility.consumePendingTargetsUpdate(message));
        await message.update(update, context);
    }

    /**
     * Re-register a self-anchored attack card in dnd5e's MessageRegistry after its attack
     * roll was mutated post-creation (retroactive advantage, bonus), refreshing the live
     * document's rolls in-memory so AC5e / dnd5e read the changed roll.
     * @param {ChatMessage} message The activation card whose attack roll changed.
     */
    static resyncAttackRegistry(message) {
        if (!message?.id || message.type !== "usage" || !message.flags?.[MODULE_SHORT]?.renderAttack) return;

        try {
            const rolls = ChatUtility.getMessageRolls(message);
            if (!rolls.some(r => RollUtility.isRollOfType(r, CONFIG.Dice.D20Roll))) return;
            ActivityUtility._updateSourcePreservingState(message, { rolls: CoreUtility.serializeRolls(rolls) });
            ActivityUtility.trackCardAsAttack(message);
        } catch (err) {
            console.warn("RSReforged | failed to re-sync attack roll registry:", err);
        }
    }

    /**
     * Fold a (pre-create, cancelled) child roll message into its RSR origin card.
     * @param {ChatMessage} parent The RSR usage card.
     * @param {ChatMessage} child The child roll message that will not be created.
     */
    static async mergeChildRollMessage(parent, child) {
        const flags = parent.flags[MODULE_SHORT];
        const childRolls = Array.from(child.rolls ?? []);
        if (!childRolls.length) return;

        let cleanType = null;
        switch (child.type) {
            case "attack": {
                cleanType = CONFIG.Dice.D20Roll;
                flags.renderAttack = true;
                flags.isCritical = ActivityUtility.isCriticalRoll(childRolls[0]);
                const mastery = child.system?.mastery ?? childRolls[0]?.options?.mastery;
                if (mastery) flags.mastery = mastery;
                const mode = child.system?.mode ?? childRolls[0]?.options?.attackMode;
                if (mode) flags.attackMode = mode;
                const ammunition = child.system?.ammunition ?? childRolls[0]?.options?.ammunition;
                if (ammunition) flags.ammunition = ammunition;
                ActivityUtility._syncAttackTargets(parent, child);
                break;
            }
            case "damage":
            case "healing":
                cleanType = CONFIG.Dice.DamageRoll;
                flags.renderDamage = true;
                flags.manualDamage = false;
                flags.isHealing = child.type === "healing" || ChatUtility.getActivityType(parent) === "heal";
                if (childRolls.some(r => r.options?.isCritical)) flags.isCritical = true;
                break;
            case "generic":
                cleanType = CONFIG.Dice.BasicRoll;
                flags.renderFormula = true;
                break;
            default:
                return;
        }

        const merged = RollUtility.mergeRollsByType(ChatUtility.getMessageRolls(parent), childRolls, cleanType);
        flags.processed = true;
        flags.quickRoll = true;
        await _provideRollFeedback(childRolls, parent);
        await ChatUtility.persistRolls(parent, merged);
        if (child.type === "attack") ChatUtility.resyncAttackRegistry(parent);
    }

    /**
     * Retroactively switch a d20 roll of a message to advantage / disadvantage / normal,
     * using the second d20 multiroll already rolled.
     * @param {ChatMessage} message
     * @param {number} rollIndex Index into ChatUtility.getMessageRolls(message).
     * @param {string} mode "adv" | "dis" | "normal".
     * @param {object} [options]
     * @param {boolean} [options.confirm=true] Honour the "confirm retroactive advantage" setting.
     */
    static async retroD20Mode(message, rollIndex, mode, { confirm = true } = {}) {
        if (!message || !ChatUtility.canModify(message)) return;
        const rolls = ChatUtility.getMessageRolls(message);
        const roll = rolls[rollIndex];
        if (!_isD20Roll(roll) || !RollUtility.getD20Term(roll)) return;
        if (RollUtility.getD20Mode(roll) === mode) return;

        if (confirm && SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_ADV)) {
            const target = CoreUtility.localize(_modeLabelKey(mode));
            const confirmed = await DialogUtility.getConfirmDialog(
                CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroAdv`, { target }));
            if (!confirmed) return;
        }

        await RollUtility.setD20Mode(roll, mode);

        const extra = {};
        const isCard = ChatUtility.isRsrUsageCard(message);
        if (isCard) {
            message.flags[MODULE_SHORT].advantage = mode === "adv";
            message.flags[MODULE_SHORT].disadvantage = mode === "dis";
        } else if (typeof message.flavor === "string") {
            extra.flavor = _flavorForMode(message.flavor, mode);
        }

        LogUtility.debug("retroD20Mode", message.id, rollIndex, mode, roll.total);
        await ChatUtility.persistRolls(message, rolls, extra);
        ChatUtility.resyncAttackRegistry(message);

        if (!game.dice3d || !game.dice3d.isEnabled()) CoreUtility.playRollSound();
    }

    /**
     * Map a chat message to the RSR roll type it represents (dnd5e 6 message types; the 5.x
     * `flags.dnd5e.roll.type` is read for legacy messages).
     * @param {ChatMessage} message
     * @returns {string|null} A ROLL_TYPE value, or null.
     */
    static getMessageType(message) {
        if (!message) return null;
        const t = message.type;
        const system = message.system ?? {};

        switch (t) {
            case "usage":
            case "dnd5e.usage":
                return ROLL_TYPE.ACTIVITY;
            case "attack":
                return ROLL_TYPE.ATTACK;
            case "damage":
            case "healing":
                return ROLL_TYPE.DAMAGE;
            case "check":
                if (system.type === "initiative") return null;
                if (system.skill) return ROLL_TYPE.SKILL;
                if (system.tool) return ROLL_TYPE.TOOL;
                return ROLL_TYPE.ABILITY_TEST;
            case "save":
                if (system.type === "death") return ROLL_TYPE.DEATH_SAVE;
                if (system.type === "concentration") return ROLL_TYPE.CONCENTRATION;
                return ROLL_TYPE.ABILITY_SAVE;
        }

        const legacy = message.flags?.dnd5e;
        if (legacy?.messageType === MESSAGE_TYPE.USAGE || !!legacy?.use) return ROLL_TYPE.ACTIVITY;
        if (legacy?.messageType === MESSAGE_TYPE.ROLL || !!legacy?.roll) {
            return legacy?.roll?.type ?? null;
        }

        return null;
    }

    static getActivityType(message) {
        // dnd5e 6.0: `system.activity` is stored reference data ({ id, img, name, type, uuid }).
        return message.system?.activity?.type ?? message.flags?.dnd5e?.activity?.type;
    }

    static getActorFromMessage(message) {
        if (typeof message.getAssociatedActor === "function") {
            const actor = message.getAssociatedActor();
            if (actor) return actor;
        }
        if (message.speaker?.token && message.speaker?.scene) {
            const token = game.scenes.get(message.speaker.scene)?.tokens?.get(message.speaker.token);
            if (token?.actor) return token.actor;
        }
        if (message.speaker?.actor) {
            return game.actors.get(message.speaker.actor) ?? null;
        }
        return null;
    }

    static isMessageCritical(message) {
        return message.flags?.[MODULE_SHORT]?.isCritical ?? false;
    }
}

/* -------------------------------------------- */
/*  Pending quick-roll actions                  */
/* -------------------------------------------- */

async function _runPendingActions(message, element) {
    message._rsrIsProcessing = true;
    try {
        if (CoreUtility.hasModule(MODULE_MIDI)) {
            const activityType = ChatUtility.getActivityType(message);
            if (activityType == ROLL_TYPE.ATTACK || (activityType == ROLL_TYPE.ABILITY_SAVE && message.flags[MODULE_SHORT].renderDamage)) {
                message.flags[MODULE_SHORT].processed = true;
                await ChatUtility.updateChatMessage(message, { flags: message.flags });
                return;
            }
        }
        await ActivityUtility.runActivityActions(message);
    } catch (err) {
        // Never leave the card hidden (rsr-hide) behind a failed roll.
        LogUtility.logError(`Failed to run activity rolls: ${err?.message ?? err}`, { ui: false });
        console.error(err);
        message._rsrIsProcessing = false;
        element.classList.remove("rsr-hide");
    }
}

/**
 * Keep the chat log pinned to the bottom after RSR unhides / rewrites a card, but only when
 * the user is already there (issue #31).
 */
function _scrollChatToBottom() {
    if (ui.chat?.isAtBottom ?? true) ui.chat?.scrollBottom?.();
}

/* -------------------------------------------- */
/*  Usage card rendering (dnd5e 6 compact)      */
/* -------------------------------------------- */

function _isD20Roll(roll) {
    return !!roll && (roll instanceof CONFIG.Dice.D20Roll || roll.class === "D20Roll" || roll.constructor?.name === "D20Roll");
}

function _isDamageRoll(roll) {
    return !!roll && (roll instanceof CONFIG.Dice.DamageRoll
        || roll.class === "DamageRoll"
        || roll.constructor?.name === "DamageRoll");
}

function _getDamageRolls(message) {
    return ChatUtility.getMessageRolls(message).filter(_isDamageRoll);
}

function _render(template, context) {
    return foundry.applications.handlebars.renderTemplate(template, context);
}

/**
 * Parse an HTML string into its top-level element nodes.
 * @param {string} html
 * @returns {HTMLElement[]}
 */
function _parse(html) {
    // A plain element of the live document (not a <template>): the custom elements inside
    // (<damage-application>, <target-pill>) then upgrade normally once connected.
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    return Array.from(wrapper.children);
}

/**
 * Elements of a container that belong to it rather than to a summarized child message.
 */
function _own(container, selector) {
    return Array.from(container.querySelectorAll(selector)).filter(el => !el.closest(".card-summary"));
}

/**
 * dnd5e's _enrichChatCard moves the `dnd5e2` class from inner elements onto the message;
 * do the same for content RSR inserts afterwards.
 */
function _stripLegacyClass(nodes) {
    for (const node of nodes) {
        node.classList?.remove("dnd5e2");
        node.querySelectorAll?.(".dnd5e2").forEach(el => el.classList.remove("dnd5e2"));
    }
}

/**
 * Render an RSR usage card in dnd5e 6's compact style: the attack (targets row + roll
 * button), damage (roll button + native <damage-application> tray) and formula rows are built
 * from the system's own attack-card / damage-card / card-rolls templates and inserted after
 * the card face, before the summaries of descendant messages (saves etc.).
 * @param {ChatMessage5e} message
 * @param {HTMLElement} element
 */
async function _renderUsageCard(message, element) {
    const content = element.querySelector(".message-content");
    if (!content) return;

    // Integration surface — fires before RSR changes the dnd5e-rendered card.
    Hooks.callAll(`${MODULE_SHORT}.preRenderChatMessageContent`, message, _jq(content), ROLL_TYPE.ACTIVITY);

    const flags = message.flags[MODULE_SHORT];
    const rolls = ChatUtility.getMessageRolls(message);
    const attackIndex = rolls.findIndex(_isD20Roll);
    const damageRolls = rolls.filter(_isDamageRoll);
    // Only utility formulas RSR rolled: a usage card's own native rolls (consumption) are
    // plain BasicRolls too.
    const formulaIndex = flags.renderFormula
        ? rolls.findIndex(r => RollUtility.isRollOfType(r, CONFIG.Dice.BasicRoll)) : -1;

    // dnd5e 6 MessageRegistry entries are rebuilt from `_source.system.origin` on load, which
    // a usage card never has; re-track processed attack cards (see _registerCardAsAttack).
    if (flags.renderAttack && attackIndex >= 0) ActivityUtility.trackCardAsAttack(message);

    const card = _own(content, ".chat-card")[0] ?? null;

    // Native buttons for rolls already on the card go; the others (manual damage, a
    // cancelled configure dialog) stay and roll onto this card when clicked.
    const removeActions = [];
    if (attackIndex >= 0) removeActions.push("rollAttack");
    if (damageRolls.length) removeActions.push("rollDamage", "rollHealing");
    if (formulaIndex >= 0) removeActions.push("rollFormula");
    if (card) _removeCardButtons(card, removeActions);
    // Legacy custom-content cards may carry stray classic roll markup.
    if (rolls.length) _own(content, "div.dice-roll").forEach(el => el.remove());

    const sections = [];
    const supplements = [];

    if (attackIndex >= 0) {
        const attack = await _renderAttackSection(message, rolls[attackIndex], attackIndex);
        sections.push(...attack.nodes);
        supplements.push(...attack.supplements);
        Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, _jq(content), ROLL_TYPE.ATTACK, _jq(attack.nodes));
    }

    if (damageRolls.length) {
        const damage = await _renderDamageSection(message, damageRolls);
        sections.push(...damage.nodes);
        supplements.push(...damage.supplements);
        Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, _jq(content), ROLL_TYPE.DAMAGE, _jq(damage.nodes));
    }

    if (formulaIndex >= 0) {
        const formula = await _renderFormulaSection(message, rolls[formulaIndex], formulaIndex);
        sections.push(...formula.nodes);
        Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, _jq(content), ROLL_TYPE.FORMULA, _jq(formula.nodes));
    }

    _stripLegacyClass(sections);
    _stripLegacyClass(supplements);

    if (card) {
        _insertSupplements(card, supplements);
        card.after(...sections);
    } else {
        const firstSummary = content.querySelector(".card-summary, effect-application");
        if (firstSummary) firstSummary.before(...supplements, ...sections);
        else content.append(...supplements, ...sections);
    }

    // Trays follow dnd5e's autoCollapseChatTrays policy and remembered states.
    if (typeof message._collapseTrays === "function") message._collapseTrays(element);

    _bindNativeRollButtons(message, element);
    _injectDamageTypeToggles(message, content);
}

/**
 * Insert supplement paragraphs into the card face after dnd5e's own supplements.
 */
function _insertSupplements(card, supplements) {
    if (!supplements.length) return;
    const existing = Array.from(card.querySelectorAll(":scope > p.supplement"));
    if (existing.length) {
        existing.at(-1).after(...supplements);
        return;
    }
    const firstRow = card.querySelector(":scope > section.icon-row, :scope > recorded-targets");
    if (firstRow) firstRow.before(...supplements);
    else card.append(...supplements);
}

/**
 * Remove the dnd5e usage-card buttons whose rolls RSR already put on the card.
 * dnd5e 6 renders them in card-buttons.hbs as `section.icon-row > ul > li > button[data-action]`.
 * @param {HTMLElement} card The card's `.chat-card`.
 * @param {string[]} actions
 */
function _removeCardButtons(card, actions) {
    for (const action of actions) {
        for (const el of card.querySelectorAll(`[data-action="${action}"], [data-forward-action="${action}"]`)) {
            if (el.closest(".card-summary")) continue;
            const li = el.closest("li");
            if (li && card.contains(li) && li.querySelectorAll("button").length <= 1) li.remove();
            else el.remove();
        }
    }
    for (const row of card.querySelectorAll("section.icon-row")) {
        if (row.querySelector("ul") && !row.querySelector("li")) row.remove();
    }
    // Legacy `.card-buttons` block.
    for (const block of card.querySelectorAll(".card-buttons")) {
        if (!block.querySelector("button")) block.remove();
    }
}

/**
 * The attack as dnd5e's attack-card.hbs renders it (targets row + compact roll button).
 * @returns {Promise<{nodes: HTMLElement[], supplements: HTMLElement[]}>}
 */
async function _renderAttackSection(message, roll, index) {
    const flags = message.flags[MODULE_SHORT];
    const actor = ChatUtility.getActorFromMessage(message);
    const hidden = SettingsUtility.shouldHideNpcRollForActor(actor, ROLL_TYPE.ATTACK);
    const visibility = game.settings.get("dnd5e", "attackRollVisibility");
    const displayResult = !hidden && (game.user.isGM || (visibility !== "none"));

    RollUtility.resetRollGetters(roll);
    const rollHtml = await roll.render({
        template: TEMPLATES.ROLL_COMPACT,
        canCrit: true,
        displayResult,
        forceSuccess: false,
        isPrivate: !message.isContentVisible,
        message
    });

    const targets = _prepareTargetsContext(message, roll, hidden);
    const nodes = _parse(await _render(TEMPLATES.ATTACK_CARD, { rolls: [rollHtml], targets }));
    for (const node of nodes) node.classList.add("rsr-attack");
    for (const button of nodes.flatMap(n => Array.from(n.querySelectorAll("button.dice-roll")))) {
        button.dataset.rsrRollIndex = String(index);
        button.dataset.rsrRollType = ROLL_TYPE.ATTACK;
    }

    const supplements = [];
    const mastery = _createMasterySupplement(message, roll);
    if (mastery) supplements.push(mastery);

    // The stored fallback covers quantity-one autoDestroy ammunition, deleted before render.
    const ammunitionId = flags.ammunition;
    const liveAmmunition = actor?.items?.get(ammunitionId);
    const storedAmmunition = flags.ammunitionData ?? message.flags?.dnd5e?.roll?.ammunitionData;
    const storedAmmunitionId = storedAmmunition?._id ?? storedAmmunition?.id;
    const ammo = liveAmmunition?.name
        ?? (storedAmmunition && storedAmmunitionId === ammunitionId ? storedAmmunition.name : undefined);
    if (ammo) supplements.push(_supplement(CoreUtility.localize("DND5E.CONSUMABLE.Type.Ammunition.Label"), ammo));

    return { nodes, supplements };
}

/**
 * Target descriptors evaluated against the attack, like AttackMessageData#_prepareTargetsContext.
 */
function _prepareTargetsContext(message, roll, hidden) {
    const targets = ActivityUtility.getCardTargets(message);
    if (!Array.isArray(targets) || !targets.length || !message.isContentVisible) return [];
    const visibility = game.settings.get("dnd5e", "attackRollVisibility");
    const showAC = !hidden && (game.user.isGM || (visibility === "all"));
    const showResult = !hidden && (game.user.isGM || (visibility !== "none"));
    const isCritical = roll.isCritical === true;
    const isFumble = roll.isFumble === true;
    return targets
        .map(target => {
            const ac = Number.isFinite(target.ac) ? target.ac : null;
            const isMiss = (ac === null) || (!isCritical && ((roll.total < ac) || isFumble));
            return { ...target, ac, isMiss, showAC, showResult, hasAC: ac !== null };
        })
        .sort((lhs, rhs) => (lhs.isMiss === rhs.isMiss) ? 0 : (lhs.isMiss ? 1 : -1));
}

/**
 * The damage as dnd5e's damage-card.hbs renders it (compact total button + per-type
 * breakdown popover + native <damage-application> tray), for all damage rolls of the card.
 * @returns {Promise<{nodes: HTMLElement[], supplements: HTMLElement[]}>}
 */
async function _renderDamageSection(message, damageRolls) {
    const flags = message.flags[MODULE_SHORT];
    const aggregate = CONFIG.DND5E.aggregateDamageDisplay;
    const aggregateDamageRolls = globalThis.dnd5e?.dice?.aggregateDamageRolls;
    let display = damageRolls;
    if (aggregate && typeof aggregateDamageRolls === "function") {
        try { display = aggregateDamageRolls(damageRolls); } catch (err) { display = damageRolls; }
    }

    const parts = display.map(roll => {
        const part = typeof roll.aggregateTerms === "function"
            ? roll.aggregateTerms()
            : { type: roll.options?.type, total: Math.max(0, roll.total), constant: 0, dice: [], icon: null, method: null };
        part.config = CONFIG.DND5E.damageTypes[part.type] ?? CONFIG.DND5E.healingTypes[part.type] ?? null;
        part.label = part.config?.labelShort ?? part.config?.label ?? "";
        return part;
    });
    const total = display.reduce((sum, roll) => sum + Math.max(0, roll.total), 0);

    const isCritical = damageRolls.some(r => r.options?.isCritical) || (flags.isCritical && !flags.isHealing);
    const entries = [];
    if (isCritical) entries.push({ css: "critical", label: CoreUtility.localize("DND5E.Critical") });
    if (flags.versatile) entries.push({ label: CoreUtility.localize("DND5E.Versatile") });

    const activity = ActivityUtility._getActivityFromMessage(message);
    const onSaveKey = activity?.type === "save" && activity.damage?.onSave
        ? `DND5E.SAVE.FIELDS.damage.onSave.${activity.damage.onSave.capitalize()}` : null;

    const context = {
        isPrivate: !message.isContentVisible,
        parts,
        total,
        rows: {
            properties: { entries, icon: "fa-solid fa-tag", label: "DND5E.CHATMESSAGE.Row.Properties" }
        },
        showTray: (game.user.isGM || !!globalThis.dnd5e?.settings?.allowPlayerDamageTray) && message.isContentVisible,
        onSave: onSaveKey && game.i18n.has(onSaveKey) ? CoreUtility.localize(onSaveKey) : null
    };

    const rendered = _parse(await _render(TEMPLATES.DAMAGE_CARD, context));
    const nodes = [];
    const supplements = [];
    for (const node of rendered) {
        if (node.matches(".chat-card")) {
            // Header (none here), supplements and the properties row of the damage card.
            for (const child of Array.from(node.children)) {
                if (child.matches("p.supplement")) supplements.push(child);
                else if (child.matches("section.icon-row")) nodes.push(child);
            }
            continue;
        }
        nodes.push(node);
    }

    for (const node of nodes) node.classList.add("rsr-damage");
    const button = nodes.map(n => n.querySelector?.("button.dice-roll")).find(b => b);
    if (button) {
        button.dataset.rsrRollKind = "damage";
        button.dataset.rsrRollType = flags.isHealing ? ROLL_TYPE.HEALING : ROLL_TYPE.DAMAGE;
        // Tell damage and healing apart from the attack row on the combined card.
        const icon = button.closest("section.icon-row")?.querySelector(":scope > i");
        if (icon) {
            icon.classList.remove("fa-dice");
            icon.classList.add(flags.isHealing ? "fa-heart" : "fa-burst");
        }
    }

    return { nodes, supplements };
}

/**
 * The utility formula as a compact roll row with its label.
 * @returns {Promise<{nodes: HTMLElement[]}>}
 */
async function _renderFormulaSection(message, roll, index) {
    const flags = message.flags[MODULE_SHORT];
    const rollHtml = await roll.render({
        template: TEMPLATES.ROLL_COMPACT,
        isPrivate: !message.isContentVisible,
        message
    });
    const label = flags.formulaName ?? CoreUtility.localize("DND5E.OtherFormula");
    const rows = await _render(TEMPLATES.CARD_ROWS, {
        rows: { formula: { entries: [{ label }], icon: "fa-solid fa-calculator", label: "DND5E.OtherFormula" } }
    });
    const nodes = [..._parse(rows), ..._parse(await _render(TEMPLATES.CARD_ROLLS, { rolls: [rollHtml] }))];
    for (const node of nodes) node.classList.add("rsr-formula");
    for (const button of nodes.flatMap(n => Array.from(n.querySelectorAll("button.dice-roll")))) {
        button.dataset.rsrRollIndex = String(index);
        button.dataset.rsrRollType = ROLL_TYPE.FORMULA;
    }
    return { nodes };
}

function _supplement(label, detail) {
    const p = document.createElement("p");
    p.classList.add("supplement", "rsr-supplement");
    const strong = document.createElement("strong");
    strong.textContent = label;
    p.append(strong, document.createTextNode(` ${detail}`));
    return p;
}

function _getRollMastery(message, roll) {
    const activity = ActivityUtility._getActivityFromMessage(message);
    const mastery = message.flags?.[MODULE_SHORT]?.mastery
        ?? roll?.options?.mastery
        ?? message.flags?.dnd5e?.roll?.mastery
        ?? activity?.item?.system?.mastery;
    return typeof mastery === "string" ? mastery.toLowerCase() : "";
}

/**
 * The weapon mastery supplement, as attack-card.hbs renders it.
 */
function _createMasterySupplement(message, roll) {
    const mastery = _getRollMastery(message, roll);
    const config = CONFIG.DND5E?.weaponMasteries?.[mastery];
    if (!config) return null;
    const label = config.label ? CoreUtility.localize(config.label) : `${mastery[0].toUpperCase()}${mastery.slice(1)}`;
    const reference = config.reference ?? config.uuid ?? "";

    const p = document.createElement("p");
    p.classList.add("supplement", "rsr-supplement");
    p.dataset.rsrGeneratedMastery = mastery;
    const strong = document.createElement("strong");
    const flavorKey = "DND5E.WEAPON.Mastery.Flavor";
    strong.textContent = game.i18n.has(flavorKey) ? CoreUtility.localize(flavorKey) : "Mastery:";
    p.append(strong, document.createTextNode(" "));
    if (reference) {
        const link = document.createElement("a");
        link.classList.add("content-link");
        Object.assign(link.dataset, { link: "", uuid: reference, tooltip: label });
        link.draggable = true;
        link.textContent = label;
        p.append(link);
    } else {
        p.append(document.createTextNode(label));
    }
    return p;
}

/**
 * Route the native Attack / Damage / Healing / Other Formula buttons of an RSR card to RSR,
 * so their rolls land on this card. Capture phase on the message element runs before dnd5e's
 * own (bubbling) click handler on the same element.
 */
function _bindNativeRollButtons(message, element) {
    element.addEventListener("click", event => {
        const button = event.target?.closest?.("button[data-action]");
        if (!button || button.closest(".card-summary") || !element.contains(button)) return;
        const action = NATIVE_ROLL_ACTIONS[button.dataset.action];
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        const keys = RollUtility.readRollKeys(event);
        button.disabled = true;
        ActivityUtility.runActivityAction(message, action, {
            configure: keys.normal,
            advantage: keys.advantage || undefined,
            disadvantage: keys.disadvantage || undefined
        }).catch(err => {
            LogUtility.logError(`Failed to roll ${action}: ${err?.message ?? err}`);
            console.error(err);
        }).finally(() => { button.disabled = false; });
    }, { capture: true });
}

/* -------------------------------------------- */
/*  Roll decoration (all compact messages)      */
/* -------------------------------------------- */

/**
 * Decorate the compact roll buttons of a message and of the child messages it summarizes.
 */
function _decorateMessage(message, element) {
    const content = element.querySelector(".message-content");
    if (!content) return;

    if (ChatUtility.isRsrUsageCard(message) || DECORATED_TYPES.has(message.type)) {
        _decorateRollButtons(message, content, { summary: false });
    }

    if (message.type === "attack") _hideNativeTargetResults(message, content);

    for (const summary of content.querySelectorAll(".card-summary[data-message-id]")) {
        const child = game.messages.get(summary.dataset.messageId);
        if (child && DECORATED_TYPES.has(child.type)) _decorateRollButtons(child, summary, { summary: true });
    }
}

/**
 * The RSR roll type of a message's d20 rolls (for hidden NPC results and bonus filtering).
 */
function _rollTypeForMessage(message) {
    if (message.type === "check" && message.system?.type === "initiative") return "initiative";
    if (message.type === "generic") return ROLL_TYPE.FORMULA;
    return ChatUtility.getMessageType(message);
}

function _bonusTypeFor(rollType) {
    switch (rollType) {
        case ROLL_TYPE.ABILITY_TEST: return "check";
        case ROLL_TYPE.HEALING: return "damage";
        default: return rollType ?? "any";
    }
}

/**
 * @param {ChatMessage} message The message owning the rolls in `container`.
 * @param {HTMLElement} container The message content, or a `.card-summary` of a parent card.
 * @param {object} options
 * @param {boolean} options.summary Whether `container` is a summary inside another card.
 */
function _decorateRollButtons(message, container, { summary }) {
    const buttons = Array.from(container.querySelectorAll("button.dice-roll"))
        .filter(b => summary || !b.closest(".card-summary"));
    if (!buttons.length) return;

    const rolls = ChatUtility.getMessageRolls(message);
    const isDamageMessage = message.type === "damage" || message.type === "healing";
    const reopen = message._rsrReopen;

    buttons.forEach((button, i) => {
        let popover = button.nextElementSibling?.matches?.(".roll-breakdown") ? button.nextElementSibling : null;
        const kind = (button.dataset.rsrRollKind === "damage" || isDamageMessage) ? "damage" : "roll";
        const index = kind === "roll"
            ? (button.dataset.rsrRollIndex !== undefined ? Number(button.dataset.rsrRollIndex) : i)
            : null;
        const roll = kind === "roll" ? rolls[index] : null;
        const rollType = button.dataset.rsrRollType
            ?? (kind === "damage" ? ROLL_TYPE.DAMAGE : _rollTypeForMessage(message));

        if (_isD20Roll(roll)) {
            _decorateD20Button(button, roll);
            if (_applyHiddenNpcPresentation(message, button, popover, rollType) === "removed") popover = null;
        }

        if (popover) {
            if (!button.popoverTargetElement) button.popoverTargetElement = popover;
            if (!popover.dataset.rsrMessageId) {
                popover.dataset.rsrMessageId = message.id;
                _stampDiePaths(popover, message, kind, index, rolls);
                _addRollActions(message, button, popover, { kind, index, roll, rollType });
            }
        }

        // Re-open the breakdown the user was working in after the update re-rendered the card.
        if (reopen && popover && reopen.kind === kind && reopen.index === index && !summary === !reopen.summary) {
            delete message._rsrReopen;
            setTimeout(() => {
                if (button.isConnected && !popover.matches(":popover-open")) button.click();
            }, 100);
        }
    });
}

/**
 * Multiroll display: next to the kept die dnd5e shows on the button, show the other d20s
 * that were rolled, dimmed.
 */
function _decorateD20Button(button, roll) {
    const die = button.querySelector(".d20die");
    if (!die || button.classList.contains("rsr-multiroll")) return;
    if (!SettingsUtility.getSettingValue(SETTING_NAMES.D20_ICONS_ENABLED)) {
        die.remove();
        return;
    }
    const d20 = RollUtility.getD20Term(roll);
    const candidates = RollUtility.getD20Candidates(d20);
    if (candidates.length < 2) return;
    button.classList.add("rsr-multiroll");
    const ignored = candidates.filter(r => !r.active);
    ignored.forEach((result, n) => {
        const alt = document.createElement("span");
        alt.classList.add("d20die", "rsr-d20die-alt", "discarded");
        alt.style.setProperty("--rsr-alt-index", String(n + 1));
        alt.dataset.tooltip = CoreUtility.localize(`${MODULE_SHORT}.chat.ignoredDie`);
        alt.innerHTML = '<i class="fa-fw fa-solid fa-hexagon fa-rotate-90" inert></i><span class="roll"></span>';
        alt.querySelector(".roll").textContent = String(result.result);
        die.after(alt);
    });
}

/**
 * RSR's "hide NPC roll results" in the compact style.
 *  - "total": the total reads "???", the natural d20(s) stay visible, modifiers are removed
 *    from the breakdown;
 *  - "breakdown": the total stays, the natural d20 and the whole breakdown are hidden.
 * Success/failure markers never show for hidden rolls.
 */
function _applyHiddenNpcPresentation(message, button, popover, rollType) {
    const actor = ChatUtility.getActorFromMessage(message);
    if (!SettingsUtility.shouldHideNpcRollForActor(actor, rollType)) return;

    const breakdown = SettingsUtility.getHideNpcRollStyle() === HIDE_NPC_ROLL_STYLES.BREAKDOWN;
    button.classList.remove("success", "failure");
    button.querySelector(".icons")?.replaceChildren();
    button.classList.add("rsr-hidden-result");

    if (breakdown) {
        button.classList.remove("critical", "fumble");
        button.querySelectorAll(".d20die").forEach(el => el.remove());
        popover?.remove();
        return "removed";
    }

    const total = button.querySelector(".result .total");
    if (total) total.textContent = CoreUtility.localize(`${MODULE_SHORT}.chat.hide`);
    if (popover) {
        for (const part of popover.querySelectorAll(".tooltip-part")) {
            if (!part.querySelector(".roll.d20")) part.remove();
        }
    }
    return "masked";
}

/**
 * Hide hit/miss and AC on native attack messages of hidden NPC rolls.
 */
function _hideNativeTargetResults(message, content) {
    const actor = ChatUtility.getActorFromMessage(message);
    if (!SettingsUtility.shouldHideNpcRollForActor(actor, ROLL_TYPE.ATTACK)) return;
    for (const pill of content.querySelectorAll("target-pill")) {
        pill.removeAttribute("data-hit");
        pill.removeAttribute("data-miss");
        pill.removeAttribute("data-value");
    }
}

/**
 * Stamp each die of a breakdown with its path (roll index : index in roll.dice : result
 * index) so clicking it rerolls / fudges exactly that die (RerollManager).
 *
 * d20/basic rolls: roll-breakdown.hbs renders one `.tooltip-part` per `roll.dice` entry and
 * one `li.roll` per result. Damage: damage-breakdown.hbs renders one part per damage roll
 * (unless aggregated) with the dice of its top-level terms in reverse term order
 * (aggregateDamageTerms). Anything that does not line up is left unstamped (not rerollable).
 */
function _stampDiePaths(popover, message, kind, index, rolls) {
    const parts = Array.from(popover.querySelectorAll(".tooltip-part:not(.constant-term)"));
    if (kind === "roll") {
        const roll = rolls[index];
        if (!roll?.dice || parts.length !== roll.dice.length) return;
        parts.forEach((part, dieIndex) => {
            const items = part.querySelectorAll("li.roll");
            const results = roll.dice[dieIndex]?.results ?? [];
            if (items.length !== results.length) return;
            items.forEach((li, resultIndex) => { li.dataset.rsrPath = `${index}:${dieIndex}:${resultIndex}`; });
        });
        return;
    }

    if (CONFIG.DND5E.aggregateDamageDisplay) return;
    const damage = rolls.map((roll, i) => ({ roll, i })).filter(({ roll }) => _isDamageRoll(roll));
    if (parts.length !== damage.length) return;
    parts.forEach((part, p) => {
        const { roll, i } = damage[p];
        const paths = _damagePartDicePaths(roll);
        const items = part.querySelectorAll("li.roll");
        if (items.length !== paths.length) return;
        items.forEach((li, n) => {
            const path = paths[n];
            if (path) li.dataset.rsrPath = `${i}:${path.dieIndex}:${path.resultIndex}`;
        });
    });
}

/**
 * Mirror aggregateDamageTerms' dice order: top-level terms from last to first; dice nested in
 * pool terms are listed but not addressable (null).
 */
function _damagePartDicePaths(roll) {
    const { DiceTerm, PoolTerm } = foundry.dice.terms;
    const paths = [];
    const countPool = term => (term.rolls ?? []).reduce((n, r) => n + (r.dice ?? []).reduce((m, d) => m + (d.results?.length ?? 0), 0), 0);
    const dice = roll.dice ?? [];
    for (let i = roll.terms.length - 1; i >= 0; i--) {
        const term = roll.terms[i];
        if (term instanceof DiceTerm) {
            const dieIndex = dice.indexOf(term);
            (term.results ?? []).forEach((_, resultIndex) => paths.push(dieIndex >= 0 ? { dieIndex, resultIndex } : null));
        } else if (term instanceof PoolTerm) {
            for (let n = countPool(term); n > 0; n--) paths.push(null);
        }
    }
    return paths;
}

/**
 * The small button row in a roll's breakdown popover: "+ Bonus" on every roll,
 * Disadvantage / Normal / Advantage on d20 rolls, Critical on RSR card damage.
 */
function _addRollActions(message, button, popover, { kind, index, roll, rollType }) {
    if (!ChatUtility.canModify(message) || !message.isContentVisible) return;
    if (popover.querySelector(".rsr-roll-actions")) return;

    const overlays = SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED);
    const bar = document.createElement("div");
    bar.classList.add("rsr-roll-actions");

    const add = (action, icon, labelKey, { text, dataset = {}, pressed } = {}) => {
        const el = document.createElement("button");
        el.type = "button";
        el.classList.add("rsr-roll-action");
        el.dataset.rsrAction = action;
        Object.assign(el.dataset, dataset);
        const label = CoreUtility.localize(labelKey);
        el.dataset.tooltip = label;
        el.setAttribute("aria-label", label);
        if (pressed !== undefined) el.setAttribute("aria-pressed", String(pressed));
        el.innerHTML = `<i class="${icon}" inert></i>`;
        if (text) {
            const span = document.createElement("span");
            span.textContent = text;
            el.append(span);
        }
        bar.append(el);
        return el;
    };

    add("bonus", "fa-solid fa-plus", `${MODULE_SHORT}.chat.buttons.bonus`, {
        text: CoreUtility.localize(`${MODULE_SHORT}.chat.buttons.bonusShort`)
    });

    if (overlays && _isD20Roll(roll) && RollUtility.getD20Term(roll)) {
        const mode = RollUtility.getD20Mode(roll);
        add("mode", "fa-solid fa-chevrons-down", `${MODULE_SHORT}.chat.buttons.rollDisadvantage`,
            { dataset: { mode: "dis" }, pressed: mode === "dis" });
        add("mode", "fa-solid fa-equals", `${MODULE_SHORT}.chat.buttons.rollNormal`,
            { dataset: { mode: "normal" }, pressed: mode === "normal" });
        add("mode", "fa-solid fa-chevrons-up", `${MODULE_SHORT}.chat.buttons.rollAdvantage`,
            { dataset: { mode: "adv" }, pressed: mode === "adv" });
    }

    if (overlays && kind === "damage" && ChatUtility.isRsrUsageCard(message)
        && !ChatUtility.isMessageCritical(message) && !message.flags[MODULE_SHORT].isHealing) {
        add("crit", "fa-solid fa-burst", `${MODULE_SHORT}.chat.buttons.rollCrit`, {
            text: CoreUtility.localize("DND5E.Critical")
        });
    }

    // Plain buttons without `data-action`: dnd5e routes every [data-action] click inside a
    // system-typed card to the card's data model / activity.
    bar.addEventListener("click", event => {
        const target = event.target.closest("[data-rsr-action]");
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        _onRollAction(message, target, { kind, index, rollType, summary: !!popover.closest(".card-summary") });
    });
    // Keep a pointerdown inside the popover from reaching light-dismiss / canvas handlers.
    bar.addEventListener("pointerdown", event => event.stopPropagation());

    popover.append(bar);
}

async function _onRollAction(message, target, { kind, index, rollType, summary }) {
    message._rsrReopenCandidate = { kind, index, summary, at: Date.now() };
    try {
        switch (target.dataset.rsrAction) {
            case "bonus":
                await BonusManager.openBonusDialog(message, kind === "damage" ? "damage" : _bonusTypeFor(rollType), {
                    rollIndex: kind === "roll" ? index : undefined
                });
                break;
            case "mode":
                await ChatUtility.retroD20Mode(message, index, target.dataset.mode);
                break;
            case "crit":
                await _processRetroCrit(message);
                break;
        }
    } catch (err) {
        LogUtility.logError(`RSReforged action failed: ${err?.message ?? err}`);
        console.error(err);
    }
}

function _modeLabelKey(mode) {
    if (mode === "adv") return "DND5E.Advantage";
    if (mode === "dis") return "DND5E.Disadvantage";
    return "DND5E.Normal";
}

/**
 * Rewrite the " (Advantage)" / " (Disadvantage)" suffix dnd5e appends to a roll's flavor
 * (D20Roll._prepareMessageData).
 */
function _flavorForMode(flavor, mode) {
    const adv = ` (${CoreUtility.localize("DND5E.Advantage")})`;
    const dis = ` (${CoreUtility.localize("DND5E.Disadvantage")})`;
    let base = flavor ?? "";
    for (const suffix of [adv, dis]) {
        if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
    }
    if (mode === "adv") return base + adv;
    if (mode === "dis") return base + dis;
    return base;
}

async function _provideRollFeedback(rolls, message) {
    if (!rolls.length) return;
    if (!game.dice3d || !game.dice3d.isEnabled()) {
        CoreUtility.playRollSound();
        return;
    }
    if (!CoreUtility.dice3dAnimatesRollUpdates()) await CoreUtility.tryRollDice3D(rolls, message.id);
}

/* -------------------------------------------- */
/*  Damage types (issue #27)                    */
/* -------------------------------------------- */

function _canChangeDamageType(message) {
    return game.user.isGM || message?.isAuthor === true;
}

function _isKnownDamageType(type) {
    if (typeof type !== "string" || !type) return false;
    return Object.hasOwn(CONFIG.DND5E?.damageTypes ?? {}, type)
        || Object.hasOwn(CONFIG.DND5E?.healingTypes ?? {}, type);
}

function _getDamageTypeOptions(roll) {
    const types = roll?.options?.types;
    if (!Array.isArray(types)) return [];
    return [...new Set(types.filter(_isKnownDamageType))];
}

function _getCyclableDamageRolls(damageRolls, type) {
    if (!type) return [];
    return damageRolls.filter(roll => roll.options?.type === type && _getDamageTypeOptions(roll).length > 1);
}

function _getDamageTypeFromIcon(src = "") {
    const iconType = String(src ?? "").match(/\/damage\/([^/.]+)\./)?.[1];
    if (!iconType) return null;
    if (iconType === "maxhp") return "maximum";
    if (CONFIG.DND5E.damageTypes?.[iconType] || CONFIG.DND5E.healingTypes?.[iconType]) return iconType;
    return null;
}

function _getDamageTypeFromLabel(label = "") {
    const normalized = String(label ?? "").trim().toLowerCase();
    if (!normalized) return null;
    for (const [type, config] of Object.entries({ ...CONFIG.DND5E.damageTypes, ...CONFIG.DND5E.healingTypes })) {
        for (const value of [type, config?.label, config?.labelShort]) {
            if (value && CoreUtility.localize(String(value)).trim().toLowerCase() === normalized) return type;
        }
    }
    return null;
}

/**
 * Mark the damage breakdown parts of an RSR card whose type can be switched between the
 * activity's candidate types; clicking the type label/icon cycles it (nothing is re-rolled).
 */
function _injectDamageTypeToggles(message, content) {
    if (!_canChangeDamageType(message)) return;
    const damageRolls = _getDamageRolls(message);
    if (!damageRolls.length) return;

    const button = content.querySelector('button.dice-roll[data-rsr-roll-kind="damage"]');
    const popover = button?.nextElementSibling;
    if (!popover?.matches?.(".roll-breakdown")) return;

    for (const part of popover.querySelectorAll(".tooltip-part")) {
        const total = part.querySelector(".total");
        if (!total) continue;
        const type = _getDamageTypeFromIcon(total.querySelector("img")?.getAttribute("src"))
            ?? _getDamageTypeFromLabel(total.querySelector(".label")?.textContent);
        if (!_getCyclableDamageRolls(damageRolls, type).length) continue;
        part.classList.add("rsr-damage-type-toggle");
        part.dataset.rsrDamageType = type;
        const title = CoreUtility.localize(`${MODULE_SHORT}.chat.buttons.damageType`);
        for (const el of total.querySelectorAll(".label, img")) {
            el.dataset.tooltip = title;
            el.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                _processDamageTypeCycle(message, type);
            });
        }
    }
}

async function _processDamageTypeCycle(message, type) {
    if (!_canChangeDamageType(message) || !type) return;

    const originalRolls = ChatUtility.getMessageRolls(message);
    const damageRolls = originalRolls.filter(_isDamageRoll);
    const targets = _getCyclableDamageRolls(damageRolls, type);
    if (!targets.length) return;

    const damageTypes = { ...(message.flags[MODULE_SHORT].damageTypes ?? {}) };
    for (const roll of targets) {
        const options = _getDamageTypeOptions(roll);
        const next = options[(options.indexOf(roll.options.type) + 1) % options.length];
        roll.options.type = next;
        damageTypes[damageRolls.indexOf(roll)] = next;
    }

    message._rsrReopenCandidate = { kind: "damage", index: null, summary: false, at: Date.now() };
    message.flags[MODULE_SHORT].damageTypes = damageTypes;
    await ChatUtility.persistRolls(message, originalRolls);

    // Card first, then the activity's remembered default.
    await ActivityUtility.rememberDamageTypes(message, _getDamageRolls(message));
}

/* -------------------------------------------- */
/*  Retroactive critical                        */
/* -------------------------------------------- */

/**
 * Keep the dice already rolled on the card when it is retroactively made critical: copy each
 * base die's results into the matching die of the freshly built critical roll (pairing dice
 * of the same size in order, robust to dnd5e 6's critical term insertion/wrapping).
 */
function _copyBaseDiceIntoCritical(baseRoll, critRoll) {
    const critDice = critRoll.dice ?? [];
    let cursor = 0;

    for (const baseDie of baseRoll.dice ?? []) {
        const baseResults = baseDie.results ?? [];
        if (!baseResults.length) continue;

        let match = null;
        for (let j = cursor; j < critDice.length; j++) {
            const candidate = critDice[j];
            if (candidate.faces === baseDie.faces && (candidate.results?.length ?? 0) >= baseResults.length) {
                match = candidate;
                cursor = j + 1;
                break;
            }
        }
        if (!match) continue;

        match.results.splice(0, baseResults.length, ...foundry.utils.deepClone(baseResults));
    }

    for (const term of critRoll.terms) {
        const inner = term?.roll;
        if (inner && typeof inner._evaluateTotal === "function") {
            try { inner._total = inner._evaluateTotal(); } catch (err) { /* keep cached total */ }
        }
    }
}

async function _processRetroCrit(message) {
    if (!ChatUtility.isRsrUsageCard(message) || !ChatUtility.canModify(message)) return;

    if (SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_CRIT)) {
        const confirmed = await DialogUtility.getConfirmDialog(CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroCrit`));
        if (!confirmed) return;
    }

    const flags = message.flags[MODULE_SHORT];
    flags.isCritical = true;

    const originalRolls = ChatUtility.getMessageRolls(message);
    let newRolls = Array.from(originalRolls);

    const rolls = originalRolls.filter(_isDamageRoll);
    const crits = ActivityUtility._extractRolls(await ActivityUtility.getDamageFromMessage(message));
    if (!crits.length) {
        flags.isCritical = false;
        return;
    }

    // Retain original behavior for MIDI users if required
    if (CoreUtility.hasModule(MODULE_MIDI)) {
        newRolls = originalRolls;
    }

    for (let i = 0; i < rolls.length; i++) {
        const baseRoll = rolls[i];
        const critRoll = crits[i];
        if (!critRoll) continue;

        _copyBaseDiceIntoCritical(baseRoll, critRoll);

        RollUtility.resetRollGetters(critRoll);
        newRolls[originalRolls.indexOf(baseRoll)] = critRoll;
    }

    await CoreUtility.tryRollDice3D(crits, message.id);
    await ChatUtility.persistRolls(message, newRolls);

    if (!game.dice3d || !game.dice3d.isEnabled()) {
        CoreUtility.playRollSound();
    }
}
