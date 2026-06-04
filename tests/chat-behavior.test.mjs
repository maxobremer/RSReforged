import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeRoll, setupFoundryEnv } from "./helpers/foundry-env.mjs";

describe("ChatUtility message lifecycle behavior", () => {
    let env;
    let ChatUtility;
    let ActivityUtility;
    let MODULE_SHORT;

    beforeEach(async () => {
        vi.resetModules();
        env = await setupFoundryEnv();
        ({ MODULE_SHORT } = await import("../src/module/const.js"));
        ({ ChatUtility } = await import("../src/utils/chat.js"));
        ({ ActivityUtility } = await import("../src/utils/activity.js"));
    });

    afterEach(() => {
        // Explicit teardown so spy isolation does not depend on resetModules()
        // happening to orphan the previous module's spies.
        vi.restoreAllMocks();
    });

    it("does not process legacy usage messages without rsreforged flags (issue #15)", async () => {
        const activity = { type: "attack", hasOwnProperty: Object.prototype.hasOwnProperty };
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            flags: { dnd5e: { activity: { type: "attack", id: "activity-1" } } },
            getAssociatedActivity: () => activity
        });
        const html = $(`<article class="chat-message"><div class="message-content"><div class="card-buttons"><button data-action="rollAttack"></button></div></div></article>`);

        const setRenderFlags = vi.spyOn(ActivityUtility, "setRenderFlags");
        const runActivityActions = vi.spyOn(ActivityUtility, "runActivityActions").mockResolvedValue(undefined);
        const updateChatMessage = vi.spyOn(ChatUtility, "updateChatMessage");

        await ChatUtility.processChatMessage(message, html);

        expect(message.flags[MODULE_SHORT]).toBeUndefined();
        expect(setRenderFlags).not.toHaveBeenCalled();
        expect(runActivityActions).not.toHaveBeenCalled();
        expect(updateChatMessage).not.toHaveBeenCalled();
        expect(message.updatedWith).toBeUndefined();
        expect(html.hasClass("rsr-hide")).toBe(false);
    });

    it("runs activity actions once for creation-stamped unprocessed usage messages", async () => {
        // Forward-path complement to the issue #15 test above: a message that WAS
        // stamped at creation (quickRoll + render flags present) must still drive the
        // quick-roll pipeline. Render flags are consumed as-is — processChatMessage must
        // never re-derive them at render time (that retroactive stamping was the #15 bug),
        // so setRenderFlags must NOT be called here.
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: false,
                    renderAttack: true
                },
                dnd5e: { activity: { type: "attack" } }
            }
        });
        const html = $(`<article class="chat-message"><div class="message-content"></div></article>`);

        const setRenderFlags = vi.spyOn(ActivityUtility, "setRenderFlags");
        const runActivityActions = vi.spyOn(ActivityUtility, "runActivityActions").mockResolvedValue(undefined);

        await ChatUtility.processChatMessage(message, html);

        expect(runActivityActions).toHaveBeenCalledTimes(1);
        expect(runActivityActions).toHaveBeenCalledWith(message);
        expect(setRenderFlags).not.toHaveBeenCalled();
        // quickRoll preserved, not rewritten by the vanilla path.
        expect(message.flags[MODULE_SHORT].quickRoll).toBe(true);
        expect(html.hasClass("rsr-hide")).toBe(true);
    });

    it("renders processed usage cards after dnd5e has produced stable card HTML", async () => {
        const attack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 23, faces: 20, results: [18] });
        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 9, faces: 8, results: [6] });
        const formula = makeRoll(env.classes.BasicRoll, { formula: "1d6", total: 4, faces: 6, results: [4] });
        const actor = { isOwner: true, items: { get: vi.fn() } };
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderAttack: true,
                    renderDamage: true,
                    renderFormula: true,
                    rolls: [attack, damage, formula]
                },
                dnd5e: { activity: { type: "attack" } }
            },
            getAssociatedActor: () => actor
        });
        const html = $(`
            <article class="chat-message">
                <div class="message-content">
                    <div class="dnd5e2 chat-card usage-card">
                        <div class="card-buttons">
                            <button data-action="rollAttack"></button>
                            <button data-action="rollDamage"></button>
                            <button data-action="rollFormula"></button>
                        </div>
                        <span class="supplement">Weapon mastery</span>
                    </div>
                    <div class="dnd5e2 chat-card"><div class="dice-roll"></div></div>
                </div>
            </article>
        `);

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(html.find(".rsr-section-attack")).toHaveLength(1);
        expect(html.find(".rsr-section-damage")).toHaveLength(1);
        expect(html.find(".rsr-section-roll")).toHaveLength(1);
        expect(html.find("[data-action=rollAttack], [data-action=rollDamage], [data-action=rollFormula]")).toHaveLength(0);
        expect(html.find(".rsr-damage-buttons-xl")).toHaveLength(1);
        expect(ui.chat.scrollBottom).toHaveBeenCalled();

        const hookNames = env.hookCalls.map((call) => call.name);
        expect(hookNames).toEqual(expect.arrayContaining([
            `${MODULE_SHORT}.preRenderChatMessageContent`,
            `${MODULE_SHORT}.renderChatMessageContent`,
            `${MODULE_SHORT}.renderApplyDamageButtons`
        ]));
        expect(env.hookCalls.filter((call) => call.name === `${MODULE_SHORT}.renderRoll`).map((call) => call.args[2])).toEqual([
            "attack",
            "damage",
            "roll"
        ]);
    });

    it("uses native damage rendering when dnd5e damage apply mode is selected", async () => {
        env.settings.damageApplyMode = "dnd5e";

        const damage = makeRoll(env.classes.DamageRoll, { formula: "1d10+3", total: 11, faces: 10, results: [8] });
        const message = new env.classes.TestChatMessage({
            type: "usage",
            isAuthor: true,
            isContentVisible: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    renderDamage: true,
                    versatile: true,
                    rolls: [damage]
                },
                dnd5e: { activity: { type: "damage" } }
            }
        });
        const html = $(`<article><div class="message-content"><div class="card-buttons"><button data-action="rollDamage"></button></div></div></article>`);

        await ChatUtility.processUsageChatMessage(message, html[0]);

        expect(html.find(".rsr-section-damage")).toHaveLength(0);
        expect(html.find(".rsr-damage-buttons-xl")).toHaveLength(0);
        expect(html.find(".rsr-versatile-tag")).toHaveLength(1);
        expect(env.hookCalls.filter((call) => call.name === `${MODULE_SHORT}.renderRoll`).map((call) => call.args[2])).toEqual(["damage"]);
    });

    it("hides dnd5e roll metadata during usage-card enrichment, then restores it for RSR (#18)", () => {
        const message = new env.classes.TestChatMessage({
            type: "usage",
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: {
                    item: { id: "weapon-1" },
                    roll: { type: "attack", mastery: "sap" }
                }
            }
        });
        const html = $(`
            <article class="chat-message">
                <header class="message-header"></header>
                <div class="message-content"></div>
            </article>
        `);

        ChatUtility.suppressDnd5eEnrichedRollFlavor(message);

        expect(message.flags.dnd5e.roll).toBeUndefined();
        expect(message._rsrSuppressedDnd5eRoll).toEqual({ type: "attack", mastery: "sap" });
        expect(html[0].querySelector(".message-content .chat-card")).toBeNull();

        ChatUtility.restoreDnd5eEnrichedRollFlavor(message);

        expect(message.flags.dnd5e.roll).toEqual({ type: "attack", mastery: "sap" });
        expect(message._rsrSuppressedDnd5eRoll).toBeUndefined();
    });

    it("merges child attack rolls into their originating usage card and deletes the child message", async () => {
        const parentRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const childRoll = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 19, faces: 20, results: [14] });
        const parent = new env.classes.TestChatMessage({
            id: "parent",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentRoll]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "child",
            type: "roll",
            isAuthor: true,
            rolls: [childRoll],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(child.deleted).toBe(true);
        expect(parent.flags[MODULE_SHORT]).toMatchObject({
            quickRoll: true,
            renderAttack: true
        });
        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll"]);
        expect(parent.flags[MODULE_SHORT].rolls[0].total).toBe(19);
        expect(parent.updatedWith).toMatchObject({ flavor: "vanilla" });
        expect(child.flags[MODULE_SHORT].processed).toBe(false);
    });

    it("replaces a merged child attack roll without dropping existing damage rolls", async () => {
        const parentAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const parentDamage = makeRoll(env.classes.DamageRoll, { formula: "1d8+3", total: 8, faces: 8, results: [5] });
        const childAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+5", total: 19, faces: 20, results: [14] });
        const parent = new env.classes.TestChatMessage({
            id: "parent-with-damage",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentAttack, parentDamage]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "replacement-child",
            type: "roll",
            isAuthor: true,
            rolls: [childAttack],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll", "DamageRoll"]);
        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.total)).toEqual([19, 8]);
    });

    it("keeps existing parent rolls when a merged child carries no usable rolls", async () => {
        // Regression guard: replace-by-type must never evict same-type rolls without a
        // replacement — a child whose rolls fail to deserialize (getMessageRolls returns
        // an empty array) must leave the parent's roll data untouched.
        const parentAttack = makeRoll(env.classes.D20Roll, { formula: "1d20+3", total: 14, faces: 20, results: [11] });
        const parent = new env.classes.TestChatMessage({
            id: "parent-kept-intact",
            type: "usage",
            isAuthor: true,
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true,
                    rolls: [parentAttack]
                }
            }
        });
        const child = new env.classes.TestChatMessage({
            id: "rollless-child",
            type: "roll",
            isAuthor: true,
            rolls: [],
            flags: {
                [MODULE_SHORT]: {
                    quickRoll: true,
                    processed: true
                },
                dnd5e: { roll: { type: "attack" } }
            },
            getOriginatingMessage: () => parent
        });
        const html = $(`<article><div class="message-content"><div class="dice-roll"></div></div></article>`);

        await ChatUtility.processChatMessage(child, html);

        expect(parent.flags[MODULE_SHORT].rolls.map((roll) => roll.class)).toEqual(["D20Roll"]);
        expect(parent.flags[MODULE_SHORT].rolls[0].total).toBe(14);
    });
});
