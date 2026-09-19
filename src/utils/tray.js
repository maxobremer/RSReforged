import { MODULE_SHORT } from "../module/const.js";
import { CoreUtility } from "./core.js";
import { LogUtility } from "./log.js";

/**
 * Facelift for dnd5e 6's native <damage-application> tray
 * (applications/components/damage-application.mjs, DamageApplicationElement).
 *
 * The component builds its multiplier split-button from a module-private MULTIPLIERS list
 * through the public DamageApplicationElement#buildMultiplierButtons, and its frame once per
 * element in connectedCallback (which calls #buildTargetContainer after the multiplier row
 * exists). Custom-element lifecycle callbacks are captured at define time, so the prototype
 * methods those callbacks call are wrapped instead:
 *  - buildMultiplierButtons: "-1" shows a heart (apply as healing), "2" keeps its label with
 *    the roll's (first) damage type icon behind it, every button gets a tooltip;
 *  - buildTargetContainer: appends an hourglass button that applies the damage total as
 *    temporary HP (Actor5e#applyTempHP) to the tray's checked targets;
 *  - getMergedOptions: on RSR usage cards of save activities, pre-selects the on-save
 *    multiplier for targets whose summarized save succeeded (what dnd5e does for its own
 *    damage messages through the private #saveMultiplier).
 * Applies to every tray, RSR's cards and native damage messages alike.
 */
export class TrayUtility {
    static patchDamageApplication() {
        const cls = customElements.get("damage-application");
        if (!cls) {
            LogUtility.logWarning("dnd5e <damage-application> element not found; tray facelift disabled.", { ui: false });
            return;
        }
        const proto = cls.prototype;
        if (proto._rsrPatched) return;

        const buildMultiplierButtons = proto.buildMultiplierButtons;
        proto.buildMultiplierButtons = function (active) {
            const buttons = buildMultiplierButtons.call(this, active);
            try {
                for (const button of buttons) TrayUtility._decorateMultiplierButton(this, button);
            } catch (err) {
                console.warn("RSReforged | tray facelift failed", err);
            }
            return buttons;
        };

        const buildTargetContainer = proto.buildTargetContainer;
        proto.buildTargetContainer = function () {
            const list = buildTargetContainer.call(this);
            try {
                TrayUtility._appendTempHpButton(this);
                list.addEventListener("recorded-targets:change", () => { this._rsrDirty = false; });
            } catch (err) {
                console.warn("RSReforged | tray temp HP button failed", err);
            }
            return list;
        };

        const onChangeMultiplier = proto._onChangeMultiplier;
        proto._onChangeMultiplier = function (event) {
            if (event?.target?.closest?.(".multiplier-button")) this._rsrDirty = true;
            return onChangeMultiplier.call(this, event);
        };

        const getMergedOptions = proto.getMergedOptions;
        proto.getMergedOptions = function (uuid) {
            const merged = getMergedOptions.call(this, uuid);
            try {
                if (!this._rsrDirty && (this.getTargetOptions(uuid).multiplier === undefined)) {
                    const multiplier = TrayUtility._usageSaveMultiplier(this.chatMessage, uuid);
                    if (multiplier !== null) merged.multiplier = multiplier;
                }
            } catch (err) {
                LogUtility.debug("save multiplier lookup failed", err);
            }
            return merged;
        };

        proto._rsrPatched = true;
        LogUtility.log("Patched dnd5e damage application tray");
    }

    static _decorateMultiplierButton(tray, button) {
        const value = Number(button.value);
        const label = TrayUtility._multiplierLabel(value);
        if (label) {
            button.dataset.tooltip = label;
            button.setAttribute("aria-label", label);
        }

        if (value === -1) {
            button.classList.add("rsr-mult-healing");
            button.innerHTML = '<i class="fa-solid fa-heart" inert></i>';
        } else if (value === 2) {
            const icon = TrayUtility._primaryDamageIcon(tray);
            if (icon) {
                button.classList.add("rsr-mult-double");
                const bg = document.createElement("dnd5e-icon");
                bg.classList.add("rsr-mult-bg");
                bg.setAttribute("src", icon);
                bg.setAttribute("inert", "");
                button.prepend(bg);
            }
        }
    }

    static _multiplierLabel(value) {
        const key = {
            "-1": "healing", "0": "none", "0.25": "quarter", "0.5": "half", "1": "full", "2": "double"
        }[String(value)];
        return key ? CoreUtility.localize(`${MODULE_SHORT}.chat.tray.${key}`) : null;
    }

    /**
     * Icon of the roll's damage type (the first one when several are rolled).
     * @param {HTMLElement} tray
     * @returns {string|null}
     */
    static _primaryDamageIcon(tray) {
        const type = (tray.damages ?? []).find(d => d?.type)?.type
            ?? tray.chatMessage?.rolls?.find(r => r?.options?.type)?.options?.type;
        if (!type) return null;
        return (CONFIG.DND5E.damageTypes[type] ?? CONFIG.DND5E.healingTypes[type])?.icon ?? null;
    }

    static _appendTempHpButton(tray) {
        const row = tray.querySelector(".multiplier-row .damage-multipliers");
        if (!row || row.querySelector(".rsr-temphp-button")) return;
        const button = document.createElement("button");
        button.type = "button";
        button.classList.add("split-control", "rsr-temphp-button");
        const label = CoreUtility.localize(`${MODULE_SHORT}.chat.tray.tempHp`);
        button.dataset.tooltip = label;
        button.setAttribute("aria-label", label);
        button.innerHTML = '<i class="fa-solid fa-hourglass-half" inert></i>';
        button.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            TrayUtility.applyTempHp(tray, button);
        });
        row.append(button);
    }

    /**
     * Apply the tray's damage total as temporary hit points to its checked, owned targets.
     * @param {HTMLElement} tray A <damage-application> element.
     * @param {HTMLButtonElement} [button]
     */
    static async applyTempHp(tray, button) {
        const total = Math.floor((tray.damages ?? []).reduce((sum, d) => sum + (Number(d?.value) || 0), 0));
        if (!(total > 0)) return;
        const options = tray.targetList?.querySelectorAll("option") ?? [];
        if (button) button.disabled = true;
        try {
            for (const option of options) {
                if (!("checked" in option.dataset)) continue;
                const token = fromUuidSync(option.value);
                if (!token?.isOwner) continue;
                await token.actor?.applyTempHP(total);
            }
        } finally {
            if (button) button.disabled = false;
        }
        if (game.settings.get("dnd5e", "autoCollapseChatTrays") !== "manual") tray.open = false;
    }

    /**
     * On-save multiplier for a target of an RSR usage card whose activity is a save.
     * @param {ChatMessage} message The tray's message.
     * @param {string} uuid Target token UUID.
     * @returns {number|null}
     */
    static _usageSaveMultiplier(message, uuid) {
        if (message?.type !== "usage" || !message.flags?.[MODULE_SHORT]?.quickRoll) return null;
        const activity = message.getAssociatedActivity?.();
        if (activity?.type !== "save") return null;
        if (message.system?.outcomes?.get?.(uuid) !== "success") return null;
        switch (activity.damage?.onSave) {
            case "full": return 1;
            case "half": return .5;
            case "none": return 0;
        }
        return null;
    }
}
