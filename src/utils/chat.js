import { MODULE_SHORT } from "../module/const.js";
import { MODULE_MIDI } from "../module/integration.js";
import { TEMPLATE } from "../module/templates.js";
import { ActivityUtility } from "./activity.js";
import { CoreUtility } from "./core.js";
import { DialogUtility } from "./dialog.js";
import { LogUtility } from "./log.js";
import { RenderUtility } from "./render.js";
import { ROLL_STATE, ROLL_TYPE, RollUtility } from "./roll.js";
import { HIDE_NPC_ROLL_STYLES, SETTING_NAMES, SettingsUtility } from "./settings.js";

export const MESSAGE_TYPE = {
    ROLL: "roll",
    USAGE: "usage",
}

// The clickable affordance for changing a damage type: the type's label and icon,
// but not the value beside them.
const DAMAGE_TYPE_TOGGLE_SELECTOR = '.rsr-damage-type-toggle .total .label, .rsr-damage-type-toggle .total img';

export class ChatUtility {
    static getMessageRolls(message) {
        const flagRolls = message.flags?.[MODULE_SHORT]?.rolls;
        if (flagRolls && Array.isArray(flagRolls)) {
            return flagRolls.map(r => {
                if (r instanceof Roll) return r;
                try { return Roll.fromData(r); } catch(e) { return null; }
            }).filter(r => r);
        }
        return Array.from(message.rolls || []);
    }

    static async processChatMessage(message, html) {
        if (!message || !html) return;
        
        if (!message.flags) message.flags = {};

        const type = ChatUtility.getMessageType(message);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.QUICK_VANILLA_ENABLED) && (!message.flags[MODULE_SHORT] || !message.flags[MODULE_SHORT].quickRoll)) {
            _processVanillaMessage(message);
            await $(html).addClass("rsr-hide");
        }

        if (!message.flags[MODULE_SHORT] || !message.flags[MODULE_SHORT].quickRoll) return;

        if (!message.flags[MODULE_SHORT].processed) {
            await $(html).addClass("rsr-hide");

            if (type == ROLL_TYPE.ACTIVITY && message.isAuthor) {
                if (message._rsrIsProcessing) return;
                message._rsrIsProcessing = true;

                try {
                    if (CoreUtility.hasModule(MODULE_MIDI)) {
                        const activityType = ChatUtility.getActivityType(message);
                        if (activityType == ROLL_TYPE.ATTACK || (activityType == ROLL_TYPE.ABILITY_SAVE && message.flags[MODULE_SHORT].renderDamage)) {
                            message.flags[MODULE_SHORT].processed = true;
                        } else {
                            await ActivityUtility.runActivityActions(message);
                        }
                    } else {
                        await ActivityUtility.runActivityActions(message);
                    }
                } catch (err) {
                    // Never leave the card hidden (rsr-hide) behind a failed roll.
                    LogUtility.logError(`Failed to run activity rolls: ${err?.message ?? err}`, { ui: false });
                    console.error(err);
                    message._rsrIsProcessing = false;
                    $(html).removeClass("rsr-hide");
                }
            }
            return;
        }

        // Usage (ACTIVITY) cards have their own pipeline (re-tracking, tray state).
        if (type === ROLL_TYPE.ACTIVITY) return ChatUtility.processUsageChatMessage(message, html);

        if (game.dice3d && game.dice3d.isEnabled() && message._dice3danimating) {
            await $(html).addClass("rsr-hide");
            await game.dice3d.waitFor3DAnimationByMessageID(message.id);
        }

        let content = $(html).find('.message-content');
        if (content.length === 0) content = $(html);
        
        if (message.isAuthor && SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL) && !ChatUtility.isMessageMultiRoll(message)) {
            const newRolls = await _enforceDualRolls(message);

            if (message.flags[MODULE_SHORT].dual) {
                ChatUtility.updateChatMessage(message, {
                    flags: message.flags
                });
                return;
            }
        }

        await _injectContent(message, type, content);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED)) {
            let hoverSetupComplete = false;
            content.hover(async () => {
                if (!hoverSetupComplete) {
                    LogUtility.log("Injecting overlay hover buttons")
                    hoverSetupComplete = true;
                    await _injectOverlayButtons(message, content);
                    _onOverlayHover(message, content);
                }
            });
        }

        if (message.flags[MODULE_SHORT].processed) {
            await $(html).removeClass("rsr-hide");
        }

        _scrollChatToBottom();
    }

    /**
     * Process a usage (ACTIVITY) chat message after dnd5e's system.getHTML() has rewritten
     * the card content. Reached through processChatMessage from the dnd5e.renderChatMessage
     * hook, which fires at the end of ChatMessage5e#renderHTML() once system.getHTML() has
     * rendered usage-card.hbs into `.message-content`. The renderChatMessageHTML hook fires
     * too early — dnd5e overwrites the DOM immediately after it returns.
     *
     * @param {ChatMessage5e} message  The chat message being rendered.
     * @param {HTMLElement}   html     The rendered message element (plain HTMLElement in V14).
     */
    static async processUsageChatMessage(message, html) {
        if (!message || !html) return;

        const flags = message.flags?.[MODULE_SHORT];
        if (!flags?.quickRoll || !flags?.processed) return;

        const type = ChatUtility.getMessageType(message);
        if (type !== ROLL_TYPE.ACTIVITY) return;

        const $html = $(html);

        if (!message.isContentVisible) {
            $html.removeClass("rsr-hide");
            return;
        }

        // dnd5e 6 MessageRegistry entries are rebuilt from `_source.system.origin` on load,
        // which a usage card never has; re-track processed attack cards so
        // registry.messages.get(<cardId>, "attack") keeps resolving (see
        // ActivityUtility._registerCardAsAttack).
        if (flags.renderAttack && ChatUtility.getMessageRolls(message).some(r => RollUtility.isRollOfType(r, CONFIG.Dice.D20Roll))) {
            ActivityUtility.trackCardAsAttack(message);
        }

        if (game.dice3d && game.dice3d.isEnabled() && message._dice3danimating) {
            await $html.addClass("rsr-hide");
            await game.dice3d.waitFor3DAnimationByMessageID(message.id);
        }

        let content = $html.find('.message-content');
        if (content.length === 0) content = $html;

        if (message.isAuthor && SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_ROLL_MULTIROLL) && !ChatUtility.isMessageMultiRoll(message)) {
            await _enforceDualRolls(message);

            if (flags.dual) {
                ChatUtility.updateChatMessage(message, { flags: message.flags });
                return;
            }
        }

        await _injectContent(message, type, content);
        _applyDnd5eTrayState(message, content);

        if (SettingsUtility.getSettingValue(SETTING_NAMES.OVERLAY_BUTTONS_ENABLED)) {
            let hoverSetupComplete = false;
            content.hover(async () => {
                if (!hoverSetupComplete) {
                    LogUtility.log("Injecting overlay hover buttons");
                    hoverSetupComplete = true;
                    await _injectOverlayButtons(message, content);
                    _onOverlayHover(message, content);
                }
            });
        }

        await $html.removeClass("rsr-hide");
        _scrollChatToBottom();
    }

    static async updateChatMessage(message, update = {}, context = {}) {
        if (message instanceof ChatMessage) {
            if (update.rolls && Array.isArray(update.rolls)) {
                update.rolls = CoreUtility.serializeRolls(update.rolls);
            }
            if (!update.flags) update.flags = message.flags;

            // dnd5e 6 reads a card's rolls from `message.rolls` (the native
            // <damage-application> tray, the attack->damage registry lookup). Keep the
            // native rolls of RSR usage cards in step with RSR's authoritative flag copy
            // after retroactive changes (crit, advantage, damage type, bonus, reroll).
            // Skipped while a forced dual roll is pending (ALWAYS_ROLL_MULTIROLL): its
            // un-kept 2d20 would total both dice.
            const rsrFlags = update.flags?.[MODULE_SHORT];
            if (update.rolls === undefined && message.type === "usage"
                && Array.isArray(rsrFlags?.rolls) && rsrFlags.processed && !rsrFlags.dual) {
                update.rolls = CoreUtility.serializeRolls(rsrFlags.rolls);
            }

            Object.assign(update, ActivityUtility.consumePendingTargetsUpdate(message));
            await message.update(update, context);
        }
    }

    /**
     * Re-register a self-anchored attack card in dnd5e's MessageRegistry after its
     * attack roll was mutated post-creation (retroactive advantage/disadvantage, or a
     * bonus applied to the attack roll).
     *
     * RSR keeps authoritative rolls in flags.rsreforged.rolls and renders from them, but
     * condition modules (AC5e) and dnd5e's native attack->damage association read the
     * native message.rolls through the registry. Refresh the live document's rolls
     * in-memory (updateChatMessage also persists them for usage cards) and re-track.
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
     * Map a chat message to the RSR roll type it represents.
     *
     * dnd5e 6.0 gives every roll its own message type with a system data model
     * (data/chat-message/_module.mjs): "usage", "attack", "damage", "healing", "check"
     * (system.type "ability"|"initiative", system.skill / system.tool), "save"
     * (system.type "ability"|"concentration"|"death"), "generic" (formula), "hitDie", ...
     * The 5.x `flags.dnd5e.roll.type` no longer exists; it is read for legacy messages.
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

        // Legacy (dnd5e < 6) messages still present in a world's chat log.
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

    // dnd5e 5.3.0: getAssociatedActor() is now a native ChatMessage5e method. Use it as the
    // primary path for actor resolution. The manual speaker fallback is kept for edge cases
    // where the message is not a full ChatMessage5e instance (e.g. pre-create hooks).
    static getActorFromMessage(message) {
        if (typeof message.getAssociatedActor === "function") {
            const actor = message.getAssociatedActor();
            if (actor) return actor;
        }

        // Manual fallback using speaker data.
        if (message.speaker?.token && message.speaker?.scene) {
            const token = game.scenes.get(message.speaker.scene)?.tokens?.get(message.speaker.token);
            if (token?.actor) return token.actor;
        }
        if (message.speaker?.actor) {
            return game.actors.get(message.speaker.actor) ?? null;
        }
        return null;
    }

    static isMessageMultiRoll(message) {
        const firstRoll = ChatUtility.getMessageRolls(message)[0];
        return (message.flags[MODULE_SHORT].advantage || message.flags[MODULE_SHORT].disadvantage || message.flags[MODULE_SHORT].dual
            || (firstRoll && firstRoll.options?.advantageMode !== CONFIG.Dice.D20Roll.ADV_MODE.NORMAL)) ?? false;
    }

    static isMessageCritical(message) {
        return message.flags[MODULE_SHORT].isCritical ?? false;
    }
}

/**
 * Keep the chat log pinned to the bottom after RSR unhides / rewrites a card,
 * but only when the user is already there. Mirrors core ChatLog behavior
 * (V13+ shows a "jump to bottom" pill instead of force-scrolling users who
 * have scrolled up). Unconditional scrolling yanked every client to the
 * newest roll on each render/update (issue #31).
 */
function _scrollChatToBottom() {
    if (ui.chat?.isAtBottom ?? true) ui.chat.scrollBottom();
}

/**
 * Reapply dnd5e's native Target/Apply tray policy after RSR has rebuilt a
 * processed usage card. This preserves autoCollapseChatTrays and any manual
 * state captured in ChatMessage5e._trayStates without duplicating that logic.
 */
function _applyDnd5eTrayState(message, html) {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || typeof message?._collapseTrays !== "function") return;
    message._collapseTrays(root);
}

function _onOverlayHover(message, html) {
    const hasPermission = game.user.isGM || message?.isAuthor;
    const isItem = ChatUtility.getMessageType(message) === ROLL_TYPE.ACTIVITY;

    html.find('.rsr-overlay').show();
    html.find('.rsr-overlay-multiroll').toggle(hasPermission && !ChatUtility.isMessageMultiRoll(message));
    html.find('.rsr-overlay-crit').toggle(hasPermission && isItem && !ChatUtility.isMessageCritical(message));
}

function _onOverlayHoverEnd(html) {
    html.find(".rsr-overlay").attr("style", "display: none;");
}

function _onTooltipHover(message, html) {
    const controlled = SettingsUtility._applyDamageToSelected && canvas?.tokens?.controlled?.length > 0;
    const targeted = SettingsUtility._applyDamageToTargeted && game?.user?.targets?.size > 0;

    if (controlled || targeted) {
        html.find('.rsr-damage-buttons').show();
        html.find('.rsr-damage-buttons').removeAttr("style");
    }
}

function _onTooltipHoverEnd(html) {
    html.find(".rsr-damage-buttons").attr("style", "display: none;height: 0px");
}

function _onDamageHover(message, html) {
    const controlled = SettingsUtility._applyDamageToSelected && canvas?.tokens?.controlled?.length > 0;
    const targeted = SettingsUtility._applyDamageToTargeted && game?.user?.targets?.size > 0;

    if (controlled || targeted) {
        html.find('.rsr-damage-buttons-xl').show();
    }
}

function _onDamageHoverEnd(html) {
    html.find(".rsr-damage-buttons-xl").attr("style", "display: none;");
}

function _setupCardListeners(message, html) {
    if (SettingsUtility.getSettingValue(SETTING_NAMES.MANUAL_DAMAGE_MODE) > 0) {
        html.find(`[data-action='rsr-${ROLL_TYPE.DAMAGE}']`).click(async event => {
            await _processDamageButtonEvent(message, event);
        });
    }
    
    if (SettingsUtility._useRsrDamageApplyButtons) {
        // Narrow to RSR's own action attributes so foreign buttons injected by
        // third-party modules via the rsreforged.renderApplyDamageButtons hook
        // (see docs/INTEGRATION.md) don't get their clicks swallowed by RSR's
        // unconditional preventDefault()/stopPropagation() in the handlers.
        const rsrApplyActions = '[data-action="rsr-apply-damage"], [data-action="rsr-apply-temp"]';
        html.find('.rsr-damage-buttons').find(rsrApplyActions).click(async event => {
            await _processApplyButtonEvent(message, event);
        });

        html.find('.rsr-damage-buttons-xl').find(rsrApplyActions).click(async event => {
            await _processApplyTotalButtonEvent(message, event);
        });
    }

    html.find(DAMAGE_TYPE_TOGGLE_SELECTOR).click(async event => {
        await _processDamageTypeCycleEvent(message, event);
    });

    html.find(`[data-action='rsr-${ROLL_TYPE.CONCENTRATION}']`).click(async event => {
        await _processBreakConcentrationButtonEvent(message, event);
    });
}

function _processVanillaMessage(message) {
    if (typeof message.updateSource === "function") {
        message.updateSource({
            [`flags.${MODULE_SHORT}`]: {
                quickRoll: true,
                processed: true,
                useConfig: false
            }
        });
    } else {
        message.flags[MODULE_SHORT] = {
            quickRoll: true,
            processed: true,
            useConfig: false
        };
    }
}

async function _enforceDualRolls(message) {
    let dual = false;
    let newRolls = ChatUtility.getMessageRolls(message);
    
    for (let i = 0; i < newRolls.length; i++) {
        if (newRolls[i] instanceof CONFIG.Dice.D20Roll || newRolls[i].class === "D20Roll") {
            newRolls[i] = await RollUtility.ensureMultiRoll(newRolls[i]);
            dual = true;
        }
    }
    
    message.flags[MODULE_SHORT].dual = dual;
    message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(newRolls);
    return newRolls;
}

function _safeInsert(sectionHTML, targetHTML) {
    if (targetHTML.length === 0 || targetHTML.is('.message-content, .chat-card') || targetHTML.hasClass('chat-message')) {
        targetHTML.append(sectionHTML);
    } else {
        sectionHTML.insertBefore(targetHTML);
    }
}

/**
 * Make an RSR-rendered `.dice-roll` expandable. dnd5e only binds its expand handler
 * (ChatMessage5e#_onClickDiceRoll) to rolls present when it enriches the card, and
 * RSR's rolls are injected afterwards. The core `data-action="expandRoll"` attribute is
 * dropped because dnd5e 6 routes every `[data-action]` click inside a system-typed card
 * to the card's data model (usage cards forward unknown actions to
 * Activity#onChatAction).
 * @param {JQuery} rollHTML
 * @returns {JQuery}
 */
function _bindDiceRollToggle(rollHTML) {
    rollHTML.removeAttr('data-action');
    rollHTML.off('click.rsr').on('click.rsr', event => {
        event.stopPropagation();
        $(event.currentTarget).toggleClass('expanded');
    });
    return rollHTML;
}

/**
 * Render a roll with the classic core chat template (`.dice-roll > .dice-result >
 * .dice-formula / .dice-tooltip / h4.dice-total`) that RSR's sections, multiroll overlay
 * and apply buttons are built around. dnd5e 6 system-typed messages render rolls with the
 * compact `roll-compact.hbs` button + popover instead, so RSR renders the roll itself
 * rather than reusing the card's markup. dnd5e's roll-breakdown.hbs tooltip template is
 * still used (Roll.TOOLTIP_TEMPLATE).
 * @param {Roll} roll An evaluated roll.
 * @returns {Promise<JQuery>} The `.dice-roll` element.
 */
async function _renderRollElement(roll) {
    const rendered = $(await roll.render({ isPrivate: false }));
    let rollHTML = rendered.filter('.dice-roll');
    if (!rollHTML.length) rollHTML = rendered.find('.dice-roll');
    if (!rollHTML.length) rollHTML = $('<div class="dice-roll"></div>').append(rendered);
    return _bindDiceRollToggle(rollHTML.first());
}

/**
 * Render damage rolls as a single classic `.dice-roll` with dnd5e 6's per-damage-type
 * breakdown (templates/chat/parts/damage-breakdown.hbs — the same partial and part data
 * DamageMessageData#_prepareContext uses), so each tooltip part carries its damage type
 * icon/label for RSR's apply buttons and damage type toggles.
 * @param {DamageRoll[]} rolls Evaluated damage rolls.
 * @returns {Promise<JQuery>}
 */
async function _renderDamageRollElement(rolls) {
    const aggregate = CONFIG.DND5E.aggregateDamageDisplay;
    const aggregateDamageRolls = globalThis.dnd5e?.dice?.aggregateDamageRolls;
    let display = rolls;
    if (aggregate && typeof aggregateDamageRolls === "function") {
        try { display = aggregateDamageRolls(rolls); } catch (err) { display = rolls; }
    }

    const parts = display.map(roll => {
        const part = typeof roll.aggregateTerms === "function"
            ? roll.aggregateTerms()
            : {
                type: roll.options?.type,
                total: Math.max(0, roll.total),
                constant: 0,
                dice: roll.dice.flatMap(d => d.getTooltipData().rolls),
                icon: null,
                method: null
            };
        part.config = CONFIG.DND5E.damageTypes[part.type] ?? CONFIG.DND5E.healingTypes[part.type] ?? null;
        part.label = part.config?.labelShort ?? part.config?.label ?? "";
        return part;
    });
    const formula = display.map(r => aggregate ? r.formula : ` + ${r.formula}`).join("").replace(/^ \+ /, "");
    const total = display.reduce((sum, roll) => sum + Math.max(0, roll.total), 0);
    const breakdown = await foundry.applications.handlebars.renderTemplate(
        "systems/dnd5e/templates/chat/parts/damage-breakdown.hbs", { parts }
    );

    const rollHTML = $(`<div class="dice-roll"><div class="dice-result"><div class="dice-formula"></div>${breakdown}<h4 class="dice-total"></h4></div></div>`);
    rollHTML.find('.dice-formula').text(formula);
    rollHTML.find('.dice-total').text(total);
    return _bindDiceRollToggle(rollHTML);
}

/**
 * Elements of the card that belong to other messages: dnd5e 6 renders descendant roll
 * messages (saves against this usage, etc.) as `.card-summary` blocks inside the origin
 * card when the chatCardSummary setting is on. RSR must never touch those.
 * @param {JQuery} html
 * @param {string} selector
 * @returns {JQuery}
 */
function _findOwn(html, selector) {
    return html.find(selector).filter((_, el) => !el.closest('.card-summary'));
}

/**
 * Remove the dnd5e usage-card buttons RSR replaces and return the element RSR's sections
 * should be inserted before (or appended to).
 *
 * dnd5e 6 renders usage buttons in card-face.hbs as
 * `section.icon-row > ul > li > button[data-action]`, with grouped buttons using
 * `data-forward-action` instead of `data-action`. The legacy `.card-buttons` block no
 * longer exists (it is still honoured for cards with legacy custom content).
 * @param {JQuery} html The `.message-content` element.
 * @param {string[]} actions Button actions to remove.
 * @returns {JQuery} Anchor element.
 */
function _removeCardButtons(html, actions) {
    const buttonRows = _findOwn(html, 'section.icon-row')
        .filter((_, row) => $(row).find('button[data-action], button[data-forward-action]').length > 0);

    for (const action of actions) {
        _findOwn(html, `[data-action="${action}"], [data-forward-action="${action}"]`).each((_, el) => {
            const li = $(el).closest('li');
            if (li.length && buttonRows.has(li[0]).length && li.find('button').length <= 1) li.remove();
            else $(el).remove();
        });
    }

    let anchor = null;
    buttonRows.each((_, row) => {
        if ($(row).find('button').length === 0) $(row).remove();
        else anchor ??= $(row);
    });

    if (!anchor) {
        const legacy = _findOwn(html, '.card-buttons').first();
        if (legacy.length) anchor = legacy;
    }
    if (!anchor) {
        const card = _findOwn(html, '.chat-card').first();
        anchor = card.length ? card : html;
    }
    return anchor;
}

function _snapshotSupplements(html) {
    return html.find('.supplement').map((_, element) => element.outerHTML).get().filter(Boolean);
}

function _storeSupplementsForMerge(parent, type, html) {
    parent.flags[MODULE_SHORT].supplements ??= {};
    parent.flags[MODULE_SHORT].supplements[type] = _snapshotSupplements(html);
}

function _getRollMastery(message) {
    const roll = ChatUtility.getMessageRolls(message).find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");
    const activity = ActivityUtility._getActivityFromMessage(message);
    const mastery = message.flags?.[MODULE_SHORT]?.mastery
        ?? roll?.options?.mastery
        ?? message.flags?.dnd5e?.roll?.mastery
        ?? message.system?.mastery
        ?? activity?.item?.system?.mastery;
    return typeof mastery === "string" ? mastery.toLowerCase() : "";
}

function _getMasteryLabel(mastery) {
    const label = CONFIG.DND5E?.weaponMasteries?.[mastery]?.label;
    if (label) return CoreUtility.localize(label);
    if (!mastery) return "";
    return `${mastery[0].toUpperCase()}${mastery.slice(1)}`;
}

function _getMasteryReference(mastery) {
    const reference = CONFIG.DND5E?.weaponMasteries?.[mastery];
    return reference?.reference ?? reference?.uuid ?? "";
}

function _createMasterySupplement({ mastery, label, uuid }) {
    if (!label || !uuid) return null;

    const docType = uuid.startsWith('JournalEntryPage.') ? 'JournalEntryPage' : 'JournalEntry';
    const supplement = $('<p class="supplement"></p>');
    supplement.append($('<strong></strong>').text('Mastery: '));

    const link = $('<a class="content-link"></a>');
    link.attr({
        draggable: "true",
        "data-link": "",
        "data-type": docType,
        "data-uuid": uuid,
        "data-tooltip": label,
        "data-tooltip-direction": "UP",
        "aria-label": `${label} weapon mastery`
    });
    link.text(label);
    supplement.append(link);

    return supplement[0].outerHTML;
}

function _restoreMasterySupplement(message, host) {
    if (!host?.length) return;

    const mastery = _getRollMastery(message);
    const label = _getMasteryLabel(mastery);
    const uuid = _getMasteryReference(mastery);
    if (!label || !uuid) return;

    const existing = host.find('.supplement a').filter((_, element) => {
        return element.dataset?.tooltip === label || element.dataset?.uuid === uuid;
    });
    if (existing.length) return;

    const supplement = $(_createMasterySupplement({ mastery, label, uuid }));
    supplement.attr('data-rsr-generated-mastery', mastery);
    supplement.addClass('rsr-supplement');
    host.append(supplement);
}

function _restoreStoredSupplements(message, html) {
    const supplements = message.flags?.[MODULE_SHORT]?.supplements ?? {};

    html.find('[data-rsr-restored-supplement], [data-rsr-generated-mastery]').remove();

    const hosts = {
        [ROLL_TYPE.ATTACK]: html.find('.rsr-section-attack'),
        [ROLL_TYPE.DAMAGE]: html.find('.rsr-section-damage')
    };

    for (const [type, snippets] of Object.entries(supplements)) {
        const host = hosts[type];
        if (!host?.length || !Array.isArray(snippets) || snippets.length === 0) continue;

        const restored = $(snippets.join(""));
        restored.attr('data-rsr-restored-supplement', type);
        restored.addClass('rsr-supplement');
        host.append(restored);
    }
}

async function _injectContent(message, type, html) {
    LogUtility.log("Injecting content into chat message");

    // Integration surface — fires before any DOM removal so third-party modules
    // (wm5e, automated-conditions-5e, etc.) can snapshot the dnd5e-rendered card
    // before RSR strips it. See docs/INTEGRATION.md.
    Hooks.callAll(`${MODULE_SHORT}.preRenderChatMessageContent`, message, html, type);

    // dnd5e 6.0: a roll message's origin card is `system.origin` (ForeignDocumentField),
    // resolved by ChatMessage5e#getOriginatingMessage(), which returns `this` when there
    // is none. Only a different message is a real parent. `flags.dnd5e.originatingMessage`
    // is the 5.x location (read for legacy messages; RSR 4.x also stamped a card's own id
    // there, which is not a parent).
    let parent = null;
    if (typeof message.getOriginatingMessage === "function") {
        const origin = message.getOriginatingMessage();
        if (origin && origin !== message) parent = origin;
    }
    if (!parent && message.flags?.dnd5e?.originatingMessage
        && message.flags.dnd5e.originatingMessage !== message.id) {
        parent = game.messages.get(message.flags.dnd5e.originatingMessage) ?? null;
    }

    message.flags[MODULE_SHORT].displayChallenge = parent?.shouldDisplayChallenge ?? message.shouldDisplayChallenge;
    message.flags[MODULE_SHORT].displayAttackResult = game.user.isGM || (game.settings.get("dnd5e", "attackRollVisibility") !== "none");

    switch (type) {
        case ROLL_TYPE.DAMAGE:
            if (!message.system?.item?.id && !message.flags?.dnd5e?.item?.id) {
                if (!message.isContentVisible) return;
                const useRsrDamageButtons = SettingsUtility._useRsrDamageApplyButtons;

                message.flags[MODULE_SHORT].renderDamage = true;

                const mRolls = ChatUtility.getMessageRolls(message);
                message.flags[MODULE_SHORT].isCritical = ActivityUtility.isCriticalRoll(mRolls[0]);

                if (useRsrDamageButtons) {
                    const rolls = _getDamageRolls(message);
                    if (!rolls.length) break;

                    const rollHTML = await _renderDamageRollElement(rolls);
                    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));
                    rollHTML.find('.dice-result').addClass('rsr-damage');

                    // dnd5e 6 damage-card.hbs: `section.icon-row > button.dice-roll + .roll-breakdown`
                    // followed by the native <damage-application> tray, which RSR's buttons replace.
                    const nativeRoll = _findOwn(html, '.dice-roll').first();
                    const nativeRow = nativeRoll.closest('section.icon-row');
                    if (nativeRow.length) nativeRow.replaceWith(rollHTML);
                    else if (nativeRoll.length) nativeRoll.replaceWith(rollHTML);
                    else html.append(rollHTML);
                    _findOwn(html, '.roll-breakdown').remove();
                    _findOwn(html, 'damage-application').remove();

                    await _injectApplyDamageButtons(message, html);
                    _injectDamageTypeToggles(message, html);
                }

                break;
            }
            // falls through to ATTACK when item id is present
        case ROLL_TYPE.ATTACK:
            if (parent && parent.flags[MODULE_SHORT] && message.isAuthor) {
                _storeSupplementsForMerge(parent, type, html);

                if (type === ROLL_TYPE.ATTACK) {
                    parent.flags[MODULE_SHORT].renderAttack = true;
                    const mastery = message.system?.mastery ?? ChatUtility.getMessageRolls(message)[0]?.options?.mastery;
                    if (mastery) parent.flags[MODULE_SHORT].mastery = mastery;
                    // wm5e and other mastery modules read the card's target descriptors to
                    // resolve the attacked actor; copy them from the child roll message
                    // (dnd5e 6: system.targets) before RSR deletes it.
                    ActivityUtility._syncAttackTargets(parent, message);
                }

                if (type === ROLL_TYPE.DAMAGE) {
                    parent.flags[MODULE_SHORT].renderDamage = true;

                    const mRolls = ChatUtility.getMessageRolls(message);
                    parent.flags[MODULE_SHORT].isCritical = ActivityUtility.isCriticalRoll(mRolls[0]);

                    parent.flags[MODULE_SHORT].isHealing = message.type === "healing"
                        || ChatUtility.getActivityType(message) === "heal";
                }

                parent.flags[MODULE_SHORT].quickRoll = true;

                let newParentRolls = ChatUtility.getMessageRolls(parent);
                let newMsgRolls = ChatUtility.getMessageRolls(message);
                const cleanType = type === ROLL_TYPE.ATTACK
                    ? CONFIG.Dice.D20Roll
                    : type === ROLL_TYPE.DAMAGE
                        ? CONFIG.Dice.DamageRoll
                        : null;
                newParentRolls = RollUtility.mergeRollsByType(newParentRolls, newMsgRolls, cleanType);

                const serializedRolls = CoreUtility.serializeRolls(newParentRolls);
                parent.flags[MODULE_SHORT].rolls = serializedRolls;

                ChatUtility.updateChatMessage(parent, {
                    flags: parent.flags,
                    rolls: serializedRolls,
                    flavor: "vanilla",
                });

                message.flags[MODULE_SHORT].processed = false;
                message.delete();
                return;
            }
            break;
        case ROLL_TYPE.SKILL:
        case ROLL_TYPE.ABILITY_SAVE:
        case ROLL_TYPE.ABILITY_TEST:
        case ROLL_TYPE.DEATH_SAVE:
        case ROLL_TYPE.TOOL:
        case ROLL_TYPE.CONCENTRATION: {
            if (!message.isContentVisible) return;

            const roll = ChatUtility.getMessageRolls(message)[0];
            if (!roll) return;

            // Wire the display options first; _configureRollVisibility overrides
            // them when the roll should be hidden from this user.
            roll.options.displayChallenge = message.flags[MODULE_SHORT].displayChallenge;
            roll.options.forceSuccess = message.system?.forceSuccess ?? message.flags?.dnd5e?.roll?.forceSuccess;

            const checkActor = ChatUtility.getActorFromMessage(message);
            _configureRollVisibility(roll, type, checkActor);

            const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: type });

            // dnd5e 6 check/save cards render the roll as a compact button
            // (roll-compact.hbs: `button.dice-roll` + `.roll-breakdown` popover) inside a
            // `section.icon-row`. Replace it with the classic roll markup carrying RSR's
            // multiroll display.
            const rollHTML = await _renderRollElement(roll);
            rollHTML.addClass('rsr-roll');
            rollHTML.find('.dice-total').replaceWith(render);
            rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

            if (roll.options.hideFinalResult) {
                _applyHiddenRollPresentation(rollHTML, roll);
            }

            const nativeRoll = _findOwn(html, '.dice-roll').first();
            if (nativeRoll.length) {
                nativeRoll.next('.roll-breakdown').remove();
                nativeRoll.replaceWith(rollHTML);
            } else {
                html.append(rollHTML);
            }

            // dnd5e 6 save cards offer their own "Break Concentration" button
            // (SaveMessageData#canBreakConcentration); only add RSR's on legacy cards.
            if (message.flags[MODULE_SHORT].isConcentration && message.type !== "save") {
                await _injectBreakConcentrationButton(message, html);
            }
            break;
        }
        case ROLL_TYPE.ACTIVITY: {
            if (!message.isContentVisible) return;
            const useRsrDamageButtons = SettingsUtility._useRsrDamageApplyButtons;
            const flags = message.flags[MODULE_SHORT];
            const rendersRolls = flags.renderAttack || flags.renderFormula || flags.renderDamage || flags.manualDamage;

            // dnd5e 6 renders usage cards from usage-card.hbs, which contains no rolls. Only
            // legacy custom-content cards can carry stray roll markup; strip it (outside
            // native `.card-summary` blocks) so it is not duplicated by RSR's sections.
            if (useRsrDamageButtons || rendersRolls) {
                _findOwn(html, '.dice-roll').remove();
            }

            if (useRsrDamageButtons) {
                // In RSR apply mode RSR's buttons are the apply UI; drop any system tray
                // that is not part of a descendant summary.
                _findOwn(html, 'damage-application').each((_, el) => {
                    const wrapper = $(el).parent('.card-tray.damage-tray');
                    (wrapper.length ? wrapper : $(el)).remove();
                });
            }

            const removeActions = [];
            if (flags.renderAttack !== undefined) removeActions.push("rollAttack", "attack");
            if (flags.manualDamage || flags.renderDamage) removeActions.push("rollDamage", "damage", "rollHealing", "heal");
            if (flags.renderFormula) removeActions.push("rollFormula", "formula");
            const actions = _removeCardButtons(html, removeActions);

            if (flags.renderAttack !== undefined) {
                await _injectAttackRoll(message, actions, { contentHtml: html });
            }

            if (flags.manualDamage) {
                await _injectDamageButton(message, actions);
            }

            if (flags.renderDamage) {
                await _injectDamageRoll(message, actions, { mode: useRsrDamageButtons ? "rsr" : "native", contentHtml: html });
            }

            if (flags.renderFormula) {
                await _injectFormulaRoll(message, actions, { contentHtml: html });
            }

            if (useRsrDamageButtons) {
                await _injectApplyDamageButtons(message, html);
                _injectDamageTypeToggles(message, html);
            }

            // Supplements: snapshots stored when child roll messages were merged
            // (vanilla-mode), plus the weapon mastery reference for the attack. dnd5e 6's
            // own card-face supplements (materials, trigger) stay where the system put them.
            _restoreStoredSupplements(message, html);

            const attackSection = html.find('.rsr-section-attack');
            if (attackSection.length) {
                _restoreMasterySupplement(message, attackSection);
                attackSection.find('.supplement').addClass('rsr-supplement');
            }
            html.find('.rsr-section-damage .supplement').addClass('rsr-supplement');
            break;
        }
        default:
            break;
    }

    _setupCardListeners(message, html);

    // Integration surface — fires after RSR has finished its DOM rewrite. Primary
    // decoration point for third-party modules. See docs/INTEGRATION.md.
    Hooks.callAll(`${MODULE_SHORT}.renderChatMessageContent`, message, html, type);
}

async function _injectAttackRoll(message, html, { contentHtml = html } = {}) {
    const rolls = ChatUtility.getMessageRolls(message);
    
    const roll = rolls.find(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll" || r.constructor?.name === "D20Roll");

    if (!roll) return;
    
    RollUtility.resetRollGetters(roll);

    roll.options.displayChallenge = message.flags[MODULE_SHORT].displayAttackResult;

    // getAssociatedActor() resolves token actors (which are not in game.actors).
    const actor = ChatUtility.getActorFromMessage(message);
    _configureRollVisibility(roll, ROLL_TYPE.ATTACK, actor);

    const render = await RenderUtility.render(TEMPLATE.MULTIROLL, { roll, key: ROLL_TYPE.ATTACK });
    const rollHTML = await _renderRollElement(roll);
    rollHTML.find('.dice-total').replaceWith(render);
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    if (roll.options.hideFinalResult) {
        _applyHiddenRollPresentation(rollHTML, roll);
    }   

    // The stored fallback covers quantity-one autoDestroy ammunition, which is deleted
    // before RSR renders the combined card.
    const ammunitionId = message.flags[MODULE_SHORT].ammunition;
    const liveAmmunition = actor?.items?.get(ammunitionId);
    const storedAmmunition = message.flags[MODULE_SHORT].ammunitionData ?? message.flags?.dnd5e?.roll?.ammunitionData;
    const storedAmmunitionId = storedAmmunition?._id ?? storedAmmunition?.id;
    const ammo = liveAmmunition?.name
        ?? (storedAmmunition && storedAmmunitionId === ammunitionId
            ? storedAmmunition.name
            : undefined);

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION,
    {
        section: `rsr-section-${ROLL_TYPE.ATTACK}`,
        title: CoreUtility.localize("DND5E.Attack"),
        icon: "<dnd5e-icon src=\"systems/dnd5e/icons/svg/trait-weapon-proficiencies.svg\"></dnd5e-icon>",
        subtitle: ammo ? `${CoreUtility.localize("DND5E.CONSUMABLE.Type.Ammunition.Label")} - ${ammo}` : undefined
    }));
    
    $(sectionHTML).append(rollHTML);

    const targetsHTML = _renderAttackTargets(message, roll);
    if (targetsHTML) $(sectionHTML).append(targetsHTML);

    _safeInsert(sectionHTML, html);

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.ATTACK, sectionHTML);
}

/**
 * Render the hit/miss target row for the combined card's attack, mirroring dnd5e 6's
 * attack-card.hbs / AttackMessageData#_prepareTargetsContext. RSR's attack never becomes
 * a dnd5e "attack" message, so the system does not render this row for it.
 * @param {ChatMessage} message The usage card.
 * @param {D20Roll} roll The attack roll.
 * @returns {JQuery|null}
 */
function _renderAttackTargets(message, roll) {
    const targets = ActivityUtility.getCardTargets(message);
    if (!Array.isArray(targets) || !targets.length) return null;

    const visibility = game.settings.get("dnd5e", "attackRollVisibility");
    const hidden = roll.options?.hideFinalResult || message.flags[MODULE_SHORT].dual;
    const showAC = !hidden && (game.user.isGM || (visibility === "all"));
    const showResult = !hidden && (game.user.isGM || (visibility !== "none"));
    const isCritical = ActivityUtility.isCriticalRoll(roll);
    const isFumble = roll.isFumble === true;
    const esc = foundry.utils.escapeHTML;

    const entries = targets.map(target => {
        const ac = Number.isFinite(target.ac) ? target.ac : null;
        const isMiss = (ac === null) || (!isCritical && ((roll.total < ac) || isFumble));
        return { ...target, ac, isMiss };
    }).sort((lhs, rhs) => (lhs.isMiss === rhs.isMiss) ? 0 : (lhs.isMiss ? 1 : -1));

    const items = entries.map(target => {
        const result = showResult ? (target.isMiss ? " data-miss" : " data-hit") : "";
        const value = showAC ? ` data-value="${target.ac ?? "∞"}"` : "";
        const token = esc(target.token ?? target.actor ?? "");
        const name = esc(target.name ?? "");
        return `<li><target-pill${result}${value}><label>${name}</label><datalist><option value="${token}">${name}</option></datalist></target-pill></li>`;
    }).join("");

    const label = esc(CoreUtility.localize("DND5E.CHATMESSAGE.Row.Targets"));
    return $(`<section class="icon-row rsr-attack-targets"><i class="fa-fw fa-solid fa-bullseye" aria-label="${label}"></i><ul class="unlist targets pills">${items}</ul></section>`);
}

function _configureRollVisibility(roll, rollType, actor) {
    roll.options.hideFinalResult = SettingsUtility.shouldHideNpcRollForActor(actor, rollType);
    if (roll.options.hideFinalResult) {
        // Suppress everything that would reveal the outcome of a hidden roll:
        // the DC pass/fail icon and forced-success crit styling.
        roll.options.displayChallenge = false;
        roll.options.forceSuccess = false;
        // Record which presentation style the renderer + DOM pass should use.
        roll.options.hideRollStyle = SettingsUtility.getHideNpcRollStyle();
    }
}

function _applyHiddenRollPresentation(rollHTML, roll) {
    if (!roll?.options?.hideFinalResult) return;

    const isBreakdown = roll.options.hideRollStyle === HIDE_NPC_ROLL_STYLES.BREAKDOWN;

    if (isBreakdown) {
        // Breakdown style (issue #23): the total is shown, so the entire dice
        // breakdown must be masked — natural d20 included. Drop every tooltip part.
        rollHTML.find('.dice-tooltip .tooltip-part').remove();
    } else {
        // Total style: reveal only the natural d20. Removing flat modifiers
        // (.tooltip-part.constant) is not enough: bonus dice such as Bless or
        // Guidance render as their own non-constant tooltip part (li.roll.die.dN)
        // and would otherwise leak both the buff and the rolled value. Drop every
        // tooltip part that is not a d20 die.
        rollHTML.find('.dice-tooltip .tooltip-part').each((_i, el) => {
            const part = $(el);
            if (part.find('.roll.d20').length === 0) part.remove();
        });
    }

    rollHTML.find('.dice-formula').text("1d20 + " + CoreUtility.localize(`${MODULE_SHORT}.chat.hide`));
}

async function _injectFormulaRoll(message, html, { contentHtml = html } = {}) {
    const rolls = ChatUtility.getMessageRolls(message);
    
    // Exact class match: D20Roll and DamageRoll are BasicRoll subclasses.
    const roll = rolls.find(r => RollUtility.isRollOfType(r, CONFIG.Dice.BasicRoll));

    if (!roll) return;

    const rollHTML = await _renderRollElement(roll);
    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION,
    {
        section: `rsr-section-${ROLL_TYPE.FORMULA}`,
        title: message.flags[MODULE_SHORT].formulaName ?? CoreUtility.localize("DND5E.OtherFormula"),
        icon: "<i class=\"fas fa-dice\"></i>"
    }));
    
    $(sectionHTML).append(rollHTML);
    _safeInsert(sectionHTML, html);

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.FORMULA, sectionHTML);
}

async function _injectDamageRoll(message, html, { mode = "rsr", contentHtml = html } = {}) {
    const rolls = _getDamageRolls(message);

    if (!rolls || rolls.length === 0) return;

    const rollHTML = await _renderDamageRollElement(rolls);

    if (mode === "native") {
        // Native apply mode defers damage application to dnd5e 6's own tray. The
        // <damage-application> element reads the damage from the card's `message.rolls`
        // (DamageApplicationElement#connectedCallback), which RSR keeps in step with its
        // flag copy. Shown to the same users dnd5e's damage-card.hbs shows it to.
        const nativeHTML = $('<div class="rsr-native-damage"></div>').append(rollHTML);

        // The RSR-mode branch below tags its section title with "(Versatile)"; tag the
        // formula here so the player gets the same signal.
        if (message.flags[MODULE_SHORT].versatile) {
            const label = CoreUtility.localize("DND5E.Versatile");
            const tag = `<span class="rsr-versatile-tag">(${label})</span>`;
            const formula = rollHTML.find('.dice-formula').first();
            if (formula.length) formula.append(` ${tag}`);
        }

        const showTray = game.user.isGM || !!globalThis.dnd5e?.settings?.allowPlayerDamageTray;
        if (showTray && !_findOwn(contentHtml, 'damage-application').length) {
            nativeHTML.append('<damage-application class="dnd5e2"></damage-application>');
        }

        _safeInsert(nativeHTML, html);

        Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.DAMAGE, nativeHTML);
        return;
    }

    rollHTML.find('.dice-tooltip').prepend(rollHTML.find('.dice-formula'));
    rollHTML.find('.dice-result').addClass('rsr-damage');

    const header = message.flags[MODULE_SHORT].isHealing
        ? {
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: CoreUtility.localize("DND5E.HEAL.HealingButton"),
            icon: "<i class=\"fas fa-heart\"></i>"
        }
        : {
            section: `rsr-section-${ROLL_TYPE.DAMAGE}`,
            title: `${CoreUtility.localize("DND5E.Damage")} ${message.flags[MODULE_SHORT].versatile ? "(" + CoreUtility.localize("DND5E.Versatile") + ")": ""}`,
            icon: "<i class=\"fas fa-burst\"></i>",
            subtitle: message.flags[MODULE_SHORT].isCritical ? `${CoreUtility.localize("DND5E.CriticalHit")}!` : undefined,
            critical: message.flags[MODULE_SHORT].isCritical
        }

    const sectionHTML = $(await RenderUtility.render(TEMPLATE.SECTION, header));

    $(sectionHTML).append(rollHTML);

    const onSave = _getDamageOnSaveSupplement(message);
    if (onSave) $(sectionHTML).append(onSave);

    _safeInsert(sectionHTML, html);

    Hooks.callAll(`${MODULE_SHORT}.renderRoll`, message, contentHtml, ROLL_TYPE.DAMAGE, sectionHTML);
}

/**
 * The "On Save" note dnd5e 6 shows on a save activity's damage card (damage-card.hbs,
 * DamageMessageData `onSave`), for RSR's combined card.
 * @param {ChatMessage} message
 * @returns {JQuery|null}
 */
function _getDamageOnSaveSupplement(message) {
    const activity = ActivityUtility._getActivityFromMessage(message);
    const onSave = activity?.type === "save" ? activity.damage?.onSave : null;
    if (!onSave) return null;
    const key = `DND5E.SAVE.FIELDS.damage.onSave.${onSave.capitalize()}`;
    if (!game.i18n.has(key)) return null;
    const supplement = $('<p class="supplement rsr-supplement"></p>');
    supplement.append($('<strong></strong>').text(CoreUtility.localize("DND5E.SAVE.OnSave")));
    supplement.append(document.createTextNode(` ${CoreUtility.localize(key)}`));
    return supplement;
}

async function _injectDamageButton(message, html) {
    const button = message.flags[MODULE_SHORT].isHealing
        ? {
            title: CoreUtility.localize("DND5E.HEAL.HealingButton"),
            icon: "<i class=\"fas fa-heart\"></i>"
        } 
        : {
            title: CoreUtility.localize("DND5E.Damage"),
            icon: "<i class=\"fas fa-burst\"></i>"
        }

    const render = await RenderUtility.render(TEMPLATE.BUTTON,
    {
        action: ROLL_TYPE.DAMAGE,
        ...button
    });

    // dnd5e 6 has no `.card-buttons` block to prepend into; give the button its own row
    // at the section insertion point.
    const row = $('<div class="card-buttons rsr-card-buttons"></div>').append($(render));
    _safeInsert(row, html);
}

async function _injectBreakConcentrationButton(message, html) {
    const button = {
        // dnd5e 6 renamed DND5E.ConcentrationBreak to DND5E.CONCENTRATION.Action.Break.
        title: CoreUtility.localize(game.i18n.has("DND5E.ConcentrationBreak") ? "DND5E.ConcentrationBreak" : "DND5E.CONCENTRATION.Action.Break"),
        icon: "<i class=\"fas fa-xmark\"></i>"
    }

    const render = await RenderUtility.render(TEMPLATE.BUTTON, 
    { 
        action: ROLL_TYPE.CONCENTRATION,
        ...button
    });

    html.append($(render).addClass('rsr-concentration-buttons'));
}

/**
 * Whether the viewing user may change the damage type on this card. Mirrors the
 * gate the retroactive overlay controls use (_onOverlayHover).
 */
function _canChangeDamageType(message) {
    return game.user.isGM || message?.isAuthor === true;
}

/**
 * Whether a damage type is one the system currently registers.
 *
 * Reads the live registries rather than CONFIG.rsreforged.combinedDamageTypes, which is
 * a snapshot taken on the ready hook: a module that registers a custom damage type later
 * would otherwise be rejected here. Matches _getDamageTypeFromIcon below, and the
 * late-registration handling in _getDamageLabelToTypeMap.
 *
 * hasOwn, not `in` — the latter would accept inherited keys like "constructor".
 */
function _isKnownDamageType(type) {
    if (typeof type !== "string" || !type) return false;

    return Object.hasOwn(CONFIG.DND5E?.damageTypes ?? {}, type)
        || Object.hasOwn(CONFIG.DND5E?.healingTypes ?? {}, type);
}

/**
 * The damage types a roll can be switched between. dnd5e stores the full candidate
 * list on options.types alongside the auto-picked options.type (Activity#_processDamagePart).
 * Unknown types are dropped so cycling can never land on a type dnd5e cannot render.
 */
function _getDamageTypeOptions(roll) {
    const types = roll?.options?.types;
    if (!Array.isArray(types)) return [];

    return [...new Set(types.filter(_isKnownDamageType))];
}

/**
 * The damage rolls currently showing `type` that offer an alternative type.
 *
 * Matching on type rather than index is deliberate: with CONFIG.DND5E.aggregateDamageDisplay
 * on, dnd5e merges tooltip parts BY TYPE, so a part's index does not track a roll's index.
 *
 * Rolls sharing a type therefore cycle together. That is the only sensible reading when
 * they are aggregated into one part, and un-aggregated it still means what the click says:
 * change this damage type.
 */
function _getCyclableDamageRolls(damageRolls, type) {
    if (!type) return [];

    return damageRolls.filter(roll => roll.options?.type === type && _getDamageTypeOptions(roll).length > 1);
}

/**
 * The damage type a rendered tooltip part is displaying, read from that part alone.
 *
 * Deliberately narrower than _getApplyDamageType: that helper falls back to the first
 * typed roll on the card when a part carries no type signal, which is right for applying
 * damage but wrong here — it would tag an untyped part as cyclable and cycle a different
 * part's roll. An unresolvable part simply gets no affordance.
 */
function _getPartDamageType(total) {
    return _getDamageTypeFromIcon(total.find('img').attr('src'))
        ?? _getDamageTypeFromLabel(total.find('.label').text());
}

/**
 * Mark damage tooltip parts whose type can be changed, so the type label reads as
 * clickable (issue #27). Parts with a single candidate type get no affordance.
 *
 * dnd5e's tooltip markup carries no type or roll-index data attribute, so each part's
 * current type is resolved from its own rendered DOM.
 */
function _injectDamageTypeToggles(message, html) {
    // Cycling updates the message, and the re-render resets Foundry's dice-tooltip
    // collapse state — snapping shut the very breakdown the type label lives in. Reopen
    // it for the user who cycled; the marker is client-local, so nobody else's tooltip
    // is forced open.
    if (message._rsrExpandDamageTooltip) {
        delete message._rsrExpandDamageTooltip;
        html.find('.rsr-damage').closest('.dice-roll').addClass('expanded');
    }

    if (!_canChangeDamageType(message)) return;

    const damageRolls = _getDamageRolls(message);
    if (!damageRolls.length) return;

    html.find('.rsr-damage .dice-tooltip .tooltip-part').each((_i, el) => {
        const part = $(el);
        const total = part.find('.total');
        if (!total.length) return;

        const type = _getPartDamageType(total);
        if (!_getCyclableDamageRolls(damageRolls, type).length) return;

        part.addClass('rsr-damage-type-toggle').attr('data-rsr-damage-type', type);
        total.find('.label, img').attr('title', CoreUtility.localize(`${MODULE_SHORT}.chat.buttons.damageType`));
    });
}

async function _injectApplyDamageButtons(message, html) {
    const render = await RenderUtility.render(TEMPLATE.DAMAGE_BUTTONS, {});

    const tooltip = html.find('.rsr-damage .dice-tooltip .tooltip-part');

    if (tooltip.length > 1) {
        tooltip.append($(render));
    }

    const total = html.find('.rsr-damage');
    const renderXL = $(render);
    renderXL.removeClass('rsr-damage-buttons');
    renderXL.addClass('rsr-damage-buttons-xl');
    renderXL.find('.rsr-indicator').remove();
    total.append(renderXL);

    if (!SettingsUtility.getSettingValue(SETTING_NAMES.ALWAYS_SHOW_BUTTONS)) {
        tooltip.each((i, el) => {        
            $(el).find('.rsr-damage-buttons').attr("style", "display: none;height: 0px");
            $(el).hover(_onTooltipHover.bind(this, message, $(el)), _onTooltipHoverEnd.bind(this, $(el)));
        })

        _onDamageHoverEnd(total);
        total.hover(_onDamageHover.bind(this, message, total), _onDamageHoverEnd.bind(this, total));
    }

    Hooks.callAll(`${MODULE_SHORT}.renderApplyDamageButtons`, message, html, total);
}

async function _injectOverlayButtons(message, html) {
    await _injectOverlayRetroButtons(message, html);
    await _injectOverlayHeaderButtons(message, html);   
    
    _onOverlayHoverEnd(html);
    html.hover(_onOverlayHover.bind(this, message, html), _onOverlayHoverEnd.bind(this, html));
}

async function _injectOverlayRetroButtons(message, html) {
    const overlayMultiRoll = await RenderUtility.render(TEMPLATE.OVERLAY_MULTIROLL, {});

    html.find('.rsr-multiroll .dice-total').append($(overlayMultiRoll));

    html.find(".rsr-overlay-multiroll div").click(async event => {
        await _processRetroAdvButtonEvent(message, event);
    });
    
    const overlayCrit = await RenderUtility.render(TEMPLATE.OVERLAY_CRIT, {});

    html.find('.rsr-damage .dice-total').append($(overlayCrit));

    html.find(".rsr-overlay-crit div").click(async event => {
        await _processRetroCritButtonEvent(message, event);
    });
}

async function _injectOverlayHeaderButtons(message, html) {

}

async function _processDamageButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    message.flags[MODULE_SHORT].manualDamage = false
    message.flags[MODULE_SHORT].renderDamage = true;  

    await ActivityUtility.runActivityAction(message, ROLL_TYPE.DAMAGE);
}

async function _processBreakConcentrationButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const actor = ChatUtility.getActorFromMessage(message);

    if (actor) {
        const ActiveEffect5e = CONFIG.ActiveEffect.documentClass;
        ActiveEffect5e._manageConcentration(event, actor);
    }
}

async function _processApplyButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();
    
    const button = event.currentTarget;
    const action = button.dataset.action;
    const multiplier = Number(button.dataset.multiplier);
    const dice = $(button).closest('.tooltip-part').find('.dice');

    if (action !== "rsr-apply-damage" && action !== "rsr-apply-temp") return;

    const targets = CoreUtility.getCurrentTargets();

    if (targets.size === 0) return;

    const damage = _getApplyDamage(message, dice, multiplier);

    // These are invariant across targets — compute once instead of per-token. The
    // multiplier MAGNITUDE is what applyDamage scales by; heal-vs-damage direction
    // is carried by the damage type / the only:"healing" option, not the sign (the
    // total-button path already passes the magnitude, so the two paths now match).
    const applyAsTempHP = _shouldApplyAsTempHP(action, [damage]);
    const tempHPValue = Math.floor(damage.value * Math.abs(multiplier));
    const applyOptions = _getApplyDamageOptions(message, [damage], Math.abs(multiplier), multiplier < 0);

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;
        return applyAsTempHP
            ? await target.applyTempHP(tempHPValue)
            : await target.applyDamage([ damage ], applyOptions);
    }));

    setTimeout(() => {
        if (canvas.hud.token._displayState && canvas.hud.token._displayState !== 0) {
            canvas.hud.token.render();
        }
    }, 50);
}

async function _processApplyTotalButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;
    const multiplier = Number(button.dataset.multiplier);

    if (action !== "rsr-apply-damage" && action !== "rsr-apply-temp") return;

    const targets = CoreUtility.getCurrentTargets();

    if (targets.size === 0) return;
    
    const damages = [];

    // Deserialize the message rolls once for the whole loop instead of re-fetching
    // (and re-deserializing) them inside _getApplyDamage for every damage die.
    const damageRolls = _getDamageRolls(message);
    const children = $(button).closest('.dice-roll').find('.rsr-damage .dice-tooltip .tooltip-part .dice');

    children.each((i, el) => {
        damages.push(_getApplyDamage(message, $(el), multiplier, damageRolls));
    })

    // Invariant across targets — compute once instead of per-token.
    const applyAsTempHP = _shouldApplyAsTempHP(action, damages);
    const tempHPValue = Math.floor(damages.reduce((accumulator, currentValue) => accumulator + currentValue.value, 0) * Math.abs(multiplier));
    const applyOptions = _getApplyDamageOptions(message, damages, Math.abs(multiplier), multiplier < 0);

    await Promise.all(Array.from(targets).map(async t => {
        const target = t.actor;
        return applyAsTempHP
            ? await target.applyTempHP(tempHPValue)
            : await target.applyDamage(damages, applyOptions);
    }));

    setTimeout(() => {
        if (canvas.hud.token._displayState && canvas.hud.token._displayState !== 0) {
            canvas.hud.token.render();
        }
    }, 50);
}

function _getApplyDamage(message, dice, multiplier, damageRolls = _getDamageRolls(message)) {
    const total = dice.find('.total')
    const parsed = parseInt(total.find('.value').text());
    // A non-numeric/empty total would otherwise propagate NaN into applyDamage /
    // applyTempHP and write NaN into the target's HP; fail safe to a 0 no-op.
    const value = Number.isFinite(parsed) ? parsed : 0;
    const type = _getApplyDamageType(damageRolls, total);

    const properties = new Set(
        (damageRolls.find(r => r.options?.type === type) ?? damageRolls[0])?.options?.properties ?? []
    );
    // A negative multiplier comes from the "apply as healing" button. Temp-HP and
    // max-HP ("maximum") rolls carry their own application semantics (applyTempHP /
    // dnd5e's only:"healing" path), so keep their type intact instead of collapsing
    // it to 'healing' — otherwise the heart button would strip the type those paths
    // key on (e.g. an Aid max-HP roll would be dealt as damage).
    const resolvedType = (multiplier < 0 && type !== "temphp" && type !== "maximum") ? 'healing' : type;
    return { value: value, type: resolvedType, properties: properties };
}

function _shouldApplyAsTempHP(action, damages) {
    return action === "rsr-apply-temp" || (damages.length > 0 && damages.every(d => d.type === "temphp"));
}

function _getApplyDamageOptions(message, damages, multiplier, healingIntent = false) {
    const options = { multiplier };

    // dnd5e treats "maximum" as max-HP reduction unless the application is explicitly
    // healing. Route it to max-HP restoration when the source is a healing activity
    // (e.g. Aid) OR when the user clicked the heart/healing button — the heart is an
    // explicit "apply as healing" signal, so it must restore max HP, not reduce it.
    if (damages.some(d => d.type === "maximum") && (healingIntent || _isHealingApplyMessage(message))) {
        options.only = "healing";
    }

    return options;
}

function _isHealingApplyMessage(message) {
    return message.flags?.[MODULE_SHORT]?.isHealing === true
        || ChatUtility.getActivityType(message) === "heal"
        || message.type === "healing"
        || message.flags?.dnd5e?.roll?.type === ROLL_TYPE.HEALING;
}

function _getApplyDamageType(damageRolls, total) {
    const iconType = _getDamageTypeFromIcon(total.find('img').attr('src'));
    if (iconType) return iconType;

    const labelType = _getDamageTypeFromLabel(total.find('.label').text());
    if (labelType) return labelType;

    // No DOM signal matched a known type. Prefer an authoritative roll type (so
    // applyDamage still honors resistances/immunities) over a raw label string,
    // which on a multi-type roll would not match any CONFIG.DND5E damage key. When
    // exactly one roll type exists this returns it; with several it picks the first,
    // which the previous explicit single-type tier resolved to identically.
    return damageRolls.find(r => r.options?.type)?.options?.type
        ?? total.find('.label').text().trim().toLowerCase();
}

function _getDamageTypeFromIcon(src = "") {
    const iconType = src.match(/\/damage\/([^/.]+)\./)?.[1];
    if (!iconType) return null;
    if (iconType === "maxhp") return "maximum";
    if (CONFIG.DND5E.damageTypes?.[iconType] || CONFIG.DND5E.healingTypes?.[iconType]) return iconType;
    return null;
}

let _damageLabelToTypeCache = null;

/**
 * Lazily-built, cached reverse map of normalized damage/healing labels (plus the
 * type keys and short labels) to their dnd5e type key. Rebuilding the merged map
 * on every apply click was wasted work, but the cache is rebuilt if the registered
 * type set changes size (e.g. a module adds damage/healing types after first use)
 * so it cannot go stale against late registrations.
 */
function _getDamageLabelToTypeMap() {
    const entries = {
        ...(CONFIG.DND5E.damageTypes ?? {}),
        ...(CONFIG.DND5E.healingTypes ?? {})
    };
    const typeCount = Object.keys(entries).length;
    if (_damageLabelToTypeCache?.typeCount === typeCount) return _damageLabelToTypeCache.map;

    const map = new Map();
    for (const [type, config] of Object.entries(entries)) {
        for (const value of [type, config?.label, config?.labelShort]) {
            if (value) map.set(String(value).trim().toLowerCase(), type);
        }
    }
    _damageLabelToTypeCache = { typeCount, map };
    return map;
}

function _getDamageTypeFromLabel(label = "") {
    const normalized = label.trim().toLowerCase();
    if (!normalized) return null;
    return _getDamageLabelToTypeMap().get(normalized) ?? null;
}

function _isDamageRoll(roll) {
    return roll instanceof CONFIG.Dice.DamageRoll
        || roll.class === "DamageRoll"
        || roll.constructor?.name === "DamageRoll";
}

function _getDamageRolls(message) {
    return ChatUtility.getMessageRolls(message).filter(_isDamageRoll);
}

/**
 * Cycle a damage part to its next candidate type (issue #27).
 *
 * Nothing is re-rolled — only the type flavour changes, so the total is untouched.
 * dnd5e regenerates the icon and label from options.type on re-render, and the apply
 * buttons read the type back out of that DOM, so resistances/immunities follow.
 */
async function _processDamageTypeCycleEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    // Re-check rather than trusting the injected DOM.
    if (!_canChangeDamageType(message)) return;

    const type = $(event.currentTarget).closest('.rsr-damage-type-toggle').attr('data-rsr-damage-type');
    if (!type) return;

    const originalRolls = ChatUtility.getMessageRolls(message);
    const damageRolls = originalRolls.filter(_isDamageRoll);
    const targets = _getCyclableDamageRolls(damageRolls, type);
    if (!targets.length) return;

    const damageTypes = { ...(message.flags[MODULE_SHORT].damageTypes ?? {}) };

    for (const roll of targets) {
        const options = _getDamageTypeOptions(roll);
        // A current type missing from the list wraps to the first entry rather than
        // leaving the roll stuck.
        const next = options[(options.indexOf(roll.options.type) + 1) % options.length];

        roll.options.type = next;
        // Keyed by index within the damage rolls — the array getDamageFromMessage returns.
        damageTypes[damageRolls.indexOf(roll)] = next;
    }

    // The label is only reachable with the breakdown open, so remember to reopen it
    // after the update re-renders the card (see _injectDamageTypeToggles).
    message._rsrExpandDamageTooltip = $(event.currentTarget).closest('.dice-roll').hasClass('expanded');

    message.flags[MODULE_SHORT].damageTypes = damageTypes;
    // The mutated rolls are shared with originalRolls, so serializing the full array
    // keeps the card's attack (and any other) rolls intact.
    message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(originalRolls);

    await ChatUtility.updateChatMessage(message, {
        flags: message.flags
    });

    // Card first, then the activity's default — the visible change should not wait on an
    // item write, and a failure to remember must not lose the choice already made here.
    // Re-read rather than reusing the pre-await snapshot so the default records what the
    // card actually says now. Two clients racing the same card can still land their card
    // and item writes in different orders; only the remembered default is affected, and
    // the next roll's own write corrects it.
    await ActivityUtility.rememberDamageTypes(message, _getDamageRolls(message));
}

async function _processRetroAdvButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;
    const state = button.dataset.state;
    const key = $(button).closest('.rsr-multiroll')[0].dataset.key;

    if (action === "rsr-retro") {
        if (SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_ADV)) {        
            const dialogOptions = {
                width: 100,
                top: event ? event.clientY - 50 : null,
                left: window.innerWidth - 510
            }
    
            const target = state === ROLL_STATE.ADV ? CoreUtility.localize("DND5E.Advantage") : CoreUtility.localize("DND5E.Disadvantage");
            const confirmed = await DialogUtility.getConfirmDialog(CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroAdv`, { target }), dialogOptions);
    
            if (!confirmed) return;
        }
        
        message.flags[MODULE_SHORT].advantage = state === ROLL_STATE.ADV;
        message.flags[MODULE_SHORT].disadvantage = state === ROLL_STATE.DIS;

        const originalRolls = ChatUtility.getMessageRolls(message);
        const rollIndex = originalRolls.findIndex(r => r instanceof CONFIG.Dice.D20Roll || r.class === "D20Roll");
        
        if (rollIndex > -1) {
            const upgradedRoll = await RollUtility.upgradeRoll(originalRolls[rollIndex], state);
            if (upgradedRoll) originalRolls[rollIndex] = upgradedRoll;
        }

        if (key !== ROLL_TYPE.ATTACK && key !== ROLL_TYPE.TOOL_CHECK && originalRolls[rollIndex]) {
            message.flavor += originalRolls[rollIndex].hasAdvantage 
                ? ` (${CoreUtility.localize("DND5E.Advantage")})` 
                : ` (${CoreUtility.localize("DND5E.Disadvantage")})`;
        }

        message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(originalRolls);

        await ChatUtility.updateChatMessage(message, {
            flags: message.flags,
            flavor: message.flavor
        });

        // The attack D20 roll just changed; re-register it in dnd5e's MessageRegistry so
        // AC5e resolves the upgraded roll on a subsequent damage roll. Runs after the
        // persist so it wins over dnd5e's prepareData -> track (which would re-read the
        // stale native rolls). No-ops for non-attack cards.
        ChatUtility.resyncAttackRegistry(message);

        if (!game.dice3d || !game.dice3d.isEnabled()) {
            CoreUtility.playRollSound();
        }
    }
}

/**
 * Keep the dice already rolled on the card when it is retroactively made critical: copy
 * each base die's results into the matching die of the freshly built critical roll, so
 * only the extra critical dice are new.
 *
 * dnd5e 6.0's DamageRoll#configureDamage no longer maps terms 1:1 (#applyCriticalTerm):
 * plain dice are altered in place, but modified or complex terms are followed by cloned
 * copies, terms bound by `*`, `/` or `%` are wrapped (with their copies) in a
 * ParentheticalTerm, powerful criticals add a NumericTerm, and critical bonus damage is
 * appended. Term indices therefore drift. Instead, walk both rolls' flattened dice
 * (Roll#dice, which includes dice inside parentheticals) in order and pair each base die
 * with the next critical die of the same size: originals always precede their copies, so
 * the pairing lands on the original.
 * @param {DamageRoll} baseRoll The card's current (non-critical) damage roll.
 * @param {DamageRoll} critRoll The newly rolled critical version.
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

    // Parenthetical groups cache their inner roll's total; recompute it from the new results.
    for (const term of critRoll.terms) {
        const inner = term?.roll;
        if (inner && typeof inner._evaluateTotal === "function") {
            try { inner._total = inner._evaluateTotal(); } catch (err) { /* keep cached total */ }
        }
    }
}

async function _processRetroCritButtonEvent(message, event) {
    event.preventDefault();
    event.stopPropagation();

    const button = event.currentTarget;
    const action = button.dataset.action;

    if (action === "rsr-retro") {
        if (SettingsUtility.getSettingValue(SETTING_NAMES.CONFIRM_RETRO_CRIT)) {        
            const dialogOptions = {
                width: 100,
                top: event ? event.clientY - 50 : null,
                left: window.innerWidth - 510
            }
    
            const confirmed = await DialogUtility.getConfirmDialog(CoreUtility.localize(`${MODULE_SHORT}.chat.prompts.retroCrit`), dialogOptions);
    
            if (!confirmed) return;
        }
        
        message.flags[MODULE_SHORT].isCritical = true;

        const originalRolls = ChatUtility.getMessageRolls(message);
        let newRolls = Array.from(originalRolls);

        const rolls = originalRolls.filter(_isDamageRoll);
        const crits = ActivityUtility._extractRolls(await ActivityUtility.getDamageFromMessage(message));
        if (!crits.length) {
            message.flags[MODULE_SHORT].isCritical = false;
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

        message.flags[MODULE_SHORT].rolls = CoreUtility.serializeRolls(newRolls);

        ChatUtility.updateChatMessage(message, {
            flags: message.flags
        });

        if (!game.dice3d || !game.dice3d.isEnabled()) {
            CoreUtility.playRollSound();
        }
    }
}
