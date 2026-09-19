import { MODULE_SHORT } from "../module/const.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";
import { SETTING_NAMES, SettingsUtility } from "./settings.js";

/**
 * Private roll handling (GM roll / blind / self — V14 message modes "gm" | "blind" | "self").
 *
 * Foundry keeps whispered ROLL messages `visible` to everyone and renders a "???" placeholder
 * for users who may not see the content, and dnd5e 6 folds child save/check messages into
 * their usage card (UsageMessageData#_prepareContext, filtered only by `message.visible`), so a
 * private save still shows up as a summary line with a hidden total. With the "hide private
 * rolls" setting on, a non-GM user sees neither until a GM reveals the message.
 */
export class PrivacyUtility {
    static get enabled() {
        try { return !!SettingsUtility.getSettingValue(SETTING_NAMES.HIDE_PRIVATE_ROLLS); } catch (err) { return false; }
    }

    /**
     * Whether the message is whispered or blind at all (for the GM's reveal control).
     * @param {ChatMessage} message
     * @returns {boolean}
     */
    static isPrivate(message) {
        const whisper = message?.whisper;
        return !!((whisper?.length ?? whisper?.size ?? 0) > 0 || message?.blind);
    }

    /**
     * Whether the current user must not see this message at all.
     * @param {ChatMessage} message
     * @returns {boolean}
     */
    static isHiddenFromUser(message) {
        if (!message || game.user.isGM || !PrivacyUtility.enabled) return false;
        return !message.isContentVisible;
    }

    /**
     * Hide a rendered message element from the current user if its content is private.
     * @param {ChatMessage} message
     * @param {HTMLElement} element
     * @returns {boolean} Whether the element was hidden.
     */
    static applyToElement(message, element) {
        if (!PrivacyUtility.isHiddenFromUser(message)) return false;
        element.hidden = true;
        element.classList.add("rsr-private-hidden");
        return true;
    }

    /**
     * Remove summary lines (child save/check messages folded into a usage card) whose message
     * the current user may not see, and give the GM a reveal control on private ones.
     * @param {HTMLElement} element The rendered parent message.
     */
    static processSummaries(element) {
        for (const summary of element.querySelectorAll(".card-summary[data-message-id]")) {
            const child = game.messages.get(summary.dataset.messageId);
            if (!child) continue;
            if (PrivacyUtility.isHiddenFromUser(child)) {
                summary.remove();
                continue;
            }
            if (game.user.isGM && PrivacyUtility.isPrivate(child)) {
                const host = summary.firstElementChild;
                if (host && !host.querySelector(".rsr-reveal")) {
                    host.append(PrivacyUtility._createRevealButton(child, "unbutton control-button"));
                }
            }
        }
    }

    /**
     * Add the GM-only reveal control to a private message's header.
     * @param {ChatMessage} message
     * @param {HTMLElement} element
     */
    static injectRevealButton(message, element) {
        if (!game.user.isGM || !PrivacyUtility.isPrivate(message)) return;
        const metadata = element.querySelector(".message-header .message-metadata");
        if (!metadata || metadata.querySelector(".rsr-reveal")) return;
        const button = PrivacyUtility._createRevealButton(message, "chat-control");
        const anchor = metadata.querySelector("[data-context-menu]");
        if (anchor) anchor.before(button);
        else metadata.append(button);
    }

    static _createRevealButton(message, classes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `${classes} rsr-reveal`;
        const label = CoreUtility.localize(`${MODULE_SHORT}.chat.buttons.reveal`);
        button.dataset.tooltip = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = '<i class="fa-solid fa-eye fa-fw" inert></i>';
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            PrivacyUtility.reveal(message);
        });
        return button;
    }

    /**
     * Make a message public for everyone: no whisper recipients, not blind, public mode.
     * V14's ChatMessage#applyMode is applied to a scratch copy so any mode-related fields the
     * core schema has beyond whisper/blind are carried over too.
     * @param {ChatMessage} message
     */
    static async reveal(message) {
        if (!message || !game.user.isGM) return;
        const update = { whisper: [], blind: false };
        try {
            const scratch = new ChatMessage.implementation(message.toObject());
            if (typeof scratch.applyMode === "function") {
                scratch.applyMode("public");
                const diff = foundry.utils.diffObject(message.toObject(), scratch.toObject());
                for (const key of ["rolls", "system", "flags", "content", "_id", "_stats", "timestamp", "author"]) delete diff[key];
                Object.assign(update, diff, { whisper: [], blind: false });
            }
        } catch (err) {
            LogUtility.debug("reveal: applyMode probe failed, using whisper/blind only", err);
        }
        LogUtility.debug("reveal", message.id, update);
        await message.update(update);
    }
}
