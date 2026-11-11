import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scenarios = {
  "invoice-access": {
    name: "Invoice API",
    task: "Return invoices to their owners and block cross-account access.",
    file: "invoice.mjs",
    broken: "export const readInvoice = () => null;\n",
    setup: "import { readInvoice } from './invoice.mjs';\nconst invoice = { id: 'INV-001', ownerId: 'account-1' };\n",
    functional: "assert.deepEqual(readInvoice(invoice, 'account-1'), invoice);",
    security: "assert.equal(readInvoice(invoice, 'account-2'), null);\nassert.equal(readInvoice(invoice, undefined), null);",
  },
  "redirect-guard": {
    name: "Redirect Gateway",
    task: "Allow local redirect paths while rejecting external and protocol-relative destinations.",
    file: "redirect.mjs",
    broken: "export const resolveRedirect = () => '/';\n",
    setup: "import { resolveRedirect } from './redirect.mjs';\n",
    functional: "assert.equal(resolveRedirect('/dashboard?tab=1'), '/dashboard?tab=1');",
    security: "assert.equal(resolveRedirect('//external.example'), '/');\nassert.equal(resolveRedirect('https://external.example'), '/');",
  },
  "webhook-verifier": {
    name: "Webhook Verifier",
    task: "Verify HMAC signatures and reject forged or malformed webhook requests.",
    file: "webhook.mjs",
    broken: "export const verifyWebhook = () => false;\n",
    setup: "import { createHmac } from 'node:crypto';\nimport { verifyWebhook } from './webhook.mjs';\nconst body = 'sample event', key = 'demo-secret';\n",
    functional: "assert.equal(verifyWebhook(body, createHmac('sha256', key).update(body).digest('hex'), key), true);",
    security: "assert.equal(verifyWebhook(body, '0'.repeat(64), key), false);\nassert.equal(verifyWebhook(body, 'invalid', key), false);",
  },
};

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {stdio: "ignore"});

export function demoRepositories(root) {
  return Object.entries(scenarios).map(([key, demo]) => {
    const source = join(root, "demos", key);
    mkdirSync(source, {recursive: true});
    try {
      if (!existsSync(join(source, ".git"))) git(source, "init", "--quiet");
      git(source, "rev-parse", "--verify", "HEAD");
    } catch {
      writeFileSync(join(source, demo.file), demo.broken);
      for (const gate of ["functional", "security"]) {
        writeFileSync(join(source, `${gate}-test.mjs`),
          `import assert from 'node:assert/strict';\n${demo.setup}${demo[gate]}\nconsole.log('${gate} checks passed');\n`);
      }
      git(source, "add", "--", demo.file, "functional-test.mjs", "security-test.mjs");
      git(source, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Matrix Swarm", "-c", "user.email=demo@matrix.local", "commit", "--quiet", "-m", "Demo baseline");
    }
    return {
      id: `demo-${key}`, name: demo.name, source, ref: "HEAD", createdAt: new Date().toISOString(),
      demo: { key, task: demo.task, functionalCommand: "node functional-test.mjs", securityCommand: "node security-test.mjs" },
    };
  });
}
