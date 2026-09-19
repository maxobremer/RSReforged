import { CoreUtility } from "./core.js";

/**
 * Utility class for handing configuration dialogs.
 */
export class DialogUtility {
    /**
     * Show a yes/no confirmation prompt.
     *
     * Uses ApplicationV2's DialogV2 (the V1 `Dialog` class is deprecated in Foundry V13+
     * and logs a compatibility warning on every use). Falls back to the legacy class only
     * when DialogV2 is unavailable.
     * @param {string} title  The question to ask.
     * @param {object} [options] Legacy positioning options ({ top, left, width }).
     * @returns {Promise<boolean>} Whether the user confirmed.
     */
    static async getConfirmDialog(title, options = {}) {
        const DialogV2 = foundry.applications?.api?.DialogV2;

        if (DialogV2) {
            const position = {};
            if (Number.isFinite(options.top)) position.top = options.top;
            if (Number.isFinite(options.left)) position.left = options.left;

            const result = await DialogV2.confirm({
                window: { title },
                content: `<p>${foundry.utils.escapeHTML(title)}</p>`,
                position,
                yes: { icon: "fa-solid fa-check", label: CoreUtility.localize("Yes"), default: true },
                no: { icon: "fa-solid fa-xmark", label: CoreUtility.localize("No") },
                rejectClose: false
            });
            return result === true;
        }

        return new Promise(resolve => {
            const data = {
                title,
                content: "",
                buttons: {
                    yes: {
                        icon: '<i class="fa-solid fa-check"></i>',
                        label: CoreUtility.localize("Yes"),
                        callback: () => { resolve(true); }
                    },
                    no: {
                        icon: '<i class="fa-solid fa-xmark"></i>',
                        label: CoreUtility.localize("No"),
                        callback: () => { resolve(false); }
                    }
                },
                default: "yes",
                close: () => resolve(false)
            };

            new Dialog(data, options).render(true);
        });
    }
}
