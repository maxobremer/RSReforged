import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Source-level assertions on src/utils/chat.js. These catch the regression class
// the integration API was introduced to prevent: a render function gaining a new
// early-return path without a matching Hooks.callAll emit, silently leaving
// third-party listeners (wm5e, AC5E) un-notified for that branch.
//
// A behavioural test would need a full Foundry/dnd5e/jQuery shim to drive
// _injectContent end-to-end; the failure mode we care about — "the emit is in
// the wrong function or after a return" — is fully observable at the source
// level. Keeping the test source-only also means it stays green if RSR's DOM
// internals are refactored, as long as the public contract holds.

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHAT_JS = readFileSync(resolve(__dirname, "../src/utils/chat.js"), "utf8");

function extractFunctionBody(source, signature) {
    const start = source.indexOf(signature);
    if (start === -1) throw new Error(`Function not found in chat.js: ${signature}`);
    // Skip past the parameter list to the function body's opening brace.
    // The signature may contain destructured defaults like `{ mode = "rsr" } = {}`
    // so we can't just take the first `{` after start — we need the one after
    // the matching `)` that closes the parameter list.
    let i = source.indexOf("(", start);
    let parenDepth = 0;
    for (; i < source.length; i++) {
        if (source[i] === "(") parenDepth++;
        else if (source[i] === ")") {
            parenDepth--;
            if (parenDepth === 0) { i++; break; }
        }
    }
    const bodyStart = source.indexOf("{", i);
    let depth = 0;
    for (i = bodyStart; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}") {
            depth--;
            if (depth === 0) return source.slice(bodyStart, i + 1);
        }
    }
    throw new Error(`Unbalanced braces in ${signature}`);
}

describe("Integration API: rsreforged.* hook emissions in chat.js", () => {
    it("emits exactly seven Hooks.callAll sites (one pre, one post, three roll types with damage emitting twice, one apply-damage)", () => {
        const matches = CHAT_JS.match(/Hooks\.callAll/g) ?? [];
        expect(matches.length).toBe(7);
    });

    it("emits preRenderChatMessageContent once, at the top of _injectContent", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.preRenderChatMessageContent`/g) ?? [];
        expect(calls.length).toBe(1);
        // Must precede the destructive removes — assert it comes before any html.find().remove() call.
        const callIdx = body.indexOf("preRenderChatMessageContent");
        const firstRemoveIdx = body.search(/html\.find\([^)]+\)\.remove\(\)/);
        expect(callIdx).toBeGreaterThan(-1);
        expect(firstRemoveIdx === -1 || callIdx < firstRemoveIdx).toBe(true);
    });

    it("emits renderChatMessageContent once, after _setupCardListeners", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderChatMessageContent`/g) ?? [];
        expect(calls.length).toBe(1);
        const setupIdx = body.indexOf("_setupCardListeners(message, html)");
        const callIdx = body.indexOf("renderChatMessageContent");
        expect(setupIdx).toBeGreaterThan(-1);
        expect(callIdx).toBeGreaterThan(setupIdx);
    });

    it("emits renderRoll inside _injectAttackRoll with ROLL_TYPE.ATTACK", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectAttackRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.ATTACK/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("emits renderRoll inside _injectFormulaRoll with ROLL_TYPE.FORMULA", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectFormulaRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.FORMULA/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("emits renderRoll TWICE inside _injectDamageRoll — once for native-mode early return, once for the rsr-mode tail", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectDamageRoll(message, html");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^)]*ROLL_TYPE\.DAMAGE/g) ?? [];
        expect(calls.length).toBe(2);

        // Verify the native-mode emit comes BEFORE the `return;` that exits the native branch.
        // Brace-match the `if (mode === "native") { … }` block so we don't accidentally
        // capture only up to the nested `if (... versatile) { ... }` block's closing brace.
        const ifStart = body.indexOf('if (mode === "native")');
        expect(ifStart).toBeGreaterThan(-1);
        let braceStart = body.indexOf("{", ifStart);
        let depth = 0;
        let braceEnd = -1;
        for (let i = braceStart; i < body.length; i++) {
            if (body[i] === "{") depth++;
            else if (body[i] === "}") {
                depth--;
                if (depth === 0) { braceEnd = i; break; }
            }
        }
        expect(braceEnd).toBeGreaterThan(braceStart);
        const nativeBranch = body.slice(braceStart, braceEnd + 1);
        const emitIdx = nativeBranch.indexOf("Hooks.callAll");
        const returnIdx = nativeBranch.indexOf("return;");
        expect(emitIdx).toBeGreaterThan(-1);
        expect(returnIdx).toBeGreaterThan(-1);
        expect(emitIdx).toBeLessThan(returnIdx);
    });

    it("emits renderApplyDamageButtons once at the end of _injectApplyDamageButtons", () => {
        const body = extractFunctionBody(CHAT_JS, "async function _injectApplyDamageButtons(message, html)");
        const calls = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderApplyDamageButtons`/g) ?? [];
        expect(calls.length).toBe(1);
    });

    it("uses the MODULE_SHORT template-literal namespace for every emit (so hook names track the module ID)", () => {
        const totalCalls = (CHAT_JS.match(/Hooks\.callAll\(/g) ?? []).length;
        const namespacedCalls = (CHAT_JS.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\./g) ?? []).length;
        expect(namespacedCalls).toBe(totalCalls);
    });

    it("does NOT emit any hook from updateChatMessage (re-renders re-fire the chain via the render hook; double-emit would break idempotency contracts)", () => {
        const body = extractFunctionBody(CHAT_JS, "static async updateChatMessage(message, update = {}, context = {})");
        const calls = body.match(/Hooks\.callAll/g) ?? [];
        expect(calls.length).toBe(0);
    });

    it("passes contentHtml (the outer message-content node) to renderRoll — not the insertion target — so consumers can query sibling card content", () => {
        // The hook's documented `html` arg is the message content node, NOT the
        // .card-buttons / .dnd5e2.chat-card insertion target. Each inject function
        // accepts a `contentHtml` option (defaulting to its `html` arg) and forwards
        // it to the hook. _injectContent passes its own outer html via that option
        // so listeners get the full card, not the narrow insertion slot.
        const sigs = [
            "async function _injectAttackRoll(message, html",
            "async function _injectFormulaRoll(message, html",
            "async function _injectDamageRoll(message, html",
        ];
        for (const sig of sigs) {
            // Function signature must destructure { contentHtml = html } so callers
            // can override and consumers see the outer content node.
            const sigStart = CHAT_JS.indexOf(sig);
            expect(sigStart).toBeGreaterThan(-1);
            const sigLine = CHAT_JS.slice(sigStart, CHAT_JS.indexOf("\n", sigStart));
            expect(sigLine).toMatch(/contentHtml\s*=\s*html/);

            const body = extractFunctionBody(CHAT_JS, sig);
            // All renderRoll emits inside the function pass contentHtml as the 2nd
            // positional arg (after message), not `html`.
            const emits = body.match(/Hooks\.callAll\(`\$\{MODULE_SHORT\}\.renderRoll`[^;]*?;/g) ?? [];
            expect(emits.length).toBeGreaterThan(0);
            for (const emit of emits) {
                expect(emit).toMatch(/message,\s*contentHtml,\s*ROLL_TYPE\./);
            }
        }
        // _injectContent's call sites must thread its own `html` through.
        const injectContent = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        expect(injectContent).toMatch(/_injectAttackRoll\([^)]*contentHtml:\s*html/);
        expect(injectContent).toMatch(/_injectDamageRoll\([^)]*contentHtml:\s*html/);
        expect(injectContent).toMatch(/_injectFormulaRoll\([^)]*contentHtml:\s*html/);
    });

    it("emits preRenderChatMessageContent BEFORE the child-merge return path — locks in the contract the wm5e worked example relies on", () => {
        // The child-merge path inside _injectContent (ATTACK / DAMAGE fall-through cases)
        // calls message.delete(); return; — at which point renderChatMessageContent and
        // renderRoll never fire for the child. The wm5e worked example in docs/INTEGRATION.md
        // depends on preRender having already fired by then so the listener can snapshot
        // the dnd5e card's mastery links. If preRender ever moves below the merge return,
        // the example silently breaks for the exact case it was written to handle.
        const body = extractFunctionBody(CHAT_JS, "async function _injectContent(message, type, html)");
        const preRenderIdx = body.indexOf("preRenderChatMessageContent");
        const mergeReturnIdx = body.search(/message\.delete\(\);\s*\n\s*return;/);
        expect(preRenderIdx).toBeGreaterThan(-1);
        expect(mergeReturnIdx).toBeGreaterThan(-1);
        expect(preRenderIdx).toBeLessThan(mergeReturnIdx);
    });
});
