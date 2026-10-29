import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

import { parse } from "yaml";

/**
 * Holds where the release workflow's secrets may be read. Any step of a job
 * can read every secret the job references, and the source's install and
 * build run third-party code, so each secret is kept to the jobs that
 * need it, and the deploy key out of every job that runs that code.
 */
const workflows = new URL("../.github/workflows/", import.meta.url);
/** The one module of apteoab/openbrf-modules this repository releases. */
const MODULE = "signage-residents";
const read = async (name) =>
  parse(await readFile(new URL(name, workflows), "utf8"));
const release = await read("release.yml");
const jobs = Object.entries(release.jobs);

/** Each string anywhere in a value, with the path to it. */
function* strings(value, path = []) {
  if (typeof value === "string") {
    yield [value, path];
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* strings(child, [...path, key]);
    }
  }
}

/**
 * Each expression in a string, without its string literals. An expression
 * ends at the first `}}` outside a literal, so a `}` in one, as in
 * `format('{0}', ...)`, does not end it, and a literal names no secret.
 */
const LITERAL = /'(?:[^']|'')*'/g;
const expressions = (text) =>
  [...text.matchAll(/\$\{\{((?:'(?:[^']|'')*'|[^'}]|\}(?!\}))*)\}\}/g)].map(
    ([, body]) => body.replaceAll(LITERAL, "''"),
  );

/** The names of the secrets a value refers to, with the path to each. */
function* secretReferences(value) {
  for (const [text, path] of strings(value)) {
    for (const expression of expressions(text)) {
      // Contexts and secret names are read regardless of case.
      for (const word of expression.matchAll(/\bsecrets\b(\.\w+)?/gi)) {
        // `secrets[...]` or `toJSON(secrets)` would hand on secrets this test
        // cannot name.
        assert.ok(
          word[1],
          `${path.join(".")} refers to secrets without naming one`,
        );
        yield [word[1].slice(1).toUpperCase(), path];
      }
    }
  }
}

const secretsOf = (job) =>
  new Set([...secretReferences(job)].map(([name]) => name));
const jobsReferring = (name) =>
  jobs.filter(([, job]) => secretsOf(job).has(name));
const namesOf = (holders) => holders.map(([name]) => name).sort();
const environmentOf = (job) => job.environment?.name ?? job.environment;
const runsNode = (step) =>
  /^(pnpm|actions)\/(action-setup|setup-node)@/.test(step.uses ?? "") ||
  /\b(pnpm|npm|npx|node|corepack|yarn)\b/.test(step.run ?? "");

describe("the secret scan", () => {
  const names = (text) => [...secretReferences(text)].map(([name]) => name);

  it("finds a secret in any expression", () => {
    assert.deepEqual(names("${{ secrets.A }}"), ["A"]);
    assert.deepEqual(names("x ${{ secrets.a }} ${{ SECRETS.B }}"), ["A", "B"]);
    assert.deepEqual(names("${{ format('{0}', secrets.A) }}"), ["A"]);
    assert.deepEqual(names("${{ format('}}', secrets.A) }}"), ["A"]);
    assert.deepEqual(names("${{ format('it''s {0}', secrets.A) }}"), ["A"]);
  });

  it("reads no secret in a string literal or outside an expression", () => {
    assert.deepEqual(names("secrets.A ${{ 'secrets.A' }}"), []);
  });

  it("refuses a reference to secrets that names none", () => {
    assert.throws(() => names("${{ toJSON(secrets) }}"));
    assert.throws(() => names("${{ secrets['A'] }}"));
  });
});

describe("the release workflow", () => {
  it("starts on a version tag only", () => {
    assert.deepEqual(release.on, { push: { tags: ["v*"] } });
  });

  it("refers to secrets only in a step", () => {
    assert.deepEqual([...secretReferences({ ...release, jobs: {} })], []);
    for (const [name, job] of jobs) {
      const { steps, ...rest } = job;
      assert.deepEqual(
        [...secretReferences(rest)],
        [],
        `job ${name} refers to a secret outside its steps`,
      );
      assert.notEqual(job.secrets, "inherit", `job ${name} inherits secrets`);
    }
  });

  it("refers to the deploy key and the archive key, and no other secret", () => {
    assert.deepEqual(
      [...secretsOf(release)].sort(),
      ["SOURCE_ARCHIVE_KEY", "SOURCE_DEPLOY_KEY"],
    );
  });

  it("holds each secret in an environment of its job's own", () => {
    const expected = { fetch: "release-source", build: "release-build" };
    for (const [name, job] of jobs) {
      if (secretsOf(job).size > 0) {
        assert.equal(
          environmentOf(job),
          expected[name],
          `job ${name} refers to a secret outside its environment`,
        );
      }
    }
    // The deploy key's environment is not one a job that runs the source's
    // code runs in, whichever secrets GitHub hands that job.
    for (const [holder] of jobsReferring("SOURCE_DEPLOY_KEY")) {
      const environment = environmentOf(release.jobs[holder]);
      assert.deepEqual(
        jobs
          .filter(([, job]) => environmentOf(job) === environment)
          .map(([name]) => name),
        [holder],
        `job ${holder} shares the deploy key's environment`,
      );
    }
  });

  it("fetches the source in a job that runs no Node and seals what it hands on", () => {
    const holders = jobsReferring("SOURCE_DEPLOY_KEY");
    assert.deepEqual(
      namesOf(holders),
      ["fetch"],
      "the deploy key is held by the fetch job alone",
    );
    const [[name, job]] = holders;
    for (const step of job.steps) {
      assert.ok(
        !runsNode(step),
        `job ${name} holds the deploy key and runs Node in ${step.name ?? step.uses}`,
      );
      // An action is code that runs in the job, with the key in reach.
      assert.match(
        step.uses ?? "actions/checkout@",
        /^actions\/(checkout|upload-artifact)@/,
        `job ${name} holds the deploy key and runs ${step.uses}`,
      );
      if (/^actions\/upload-artifact@/.test(step.uses ?? "")) {
        assert.match(
          step.with.path,
          /\.enc$/,
          `job ${name} uploads something it has not sealed`,
        );
      }
    }
    const steps = job.steps.filter((step) =>
      secretsOf(step).has("SOURCE_DEPLOY_KEY"),
    );
    assert.equal(steps.length, 1);
    assert.match(steps[0].uses, /^actions\/checkout@/);
    assert.equal(steps[0].with["persist-credentials"], false);
  });

  it("seals the addon's files and not the other modules'", () => {
    const [seal] = release.jobs.fetch.steps.filter((step) =>
      /\bopenssl enc\b/.test(step.run ?? ""),
    );
    const at = (pattern) => {
      const index = seal.run.search(pattern);
      assert.notEqual(index, -1, `the seal step does not run ${pattern}`);
      return index;
    };
    const tar = at(/\btar\b/);
    for (const command of [
      /fetch [^\n]*--filter=blob:none/,
      new RegExp(`sparse-checkout set --cone modules/${MODULE}\n`),
      /checkout [^\n]*FETCH_HEAD/,
      /remote remove origin/,
    ]) {
      assert.ok(at(command) < tar, `the seal step runs ${command} after tar`);
    }
  });

  it("hands the archive key to steps that run no Node, in their env", () => {
    const holders = jobsReferring("SOURCE_ARCHIVE_KEY");
    assert.deepEqual(
      namesOf(holders),
      ["build", "fetch"],
      "the archive key is held by the fetch and build jobs alone",
    );
    for (const [name, job] of holders) {
      for (const [secret, [index, ...path]] of secretReferences(job.steps)) {
        if (secret !== "SOURCE_ARCHIVE_KEY") continue;
        assert.deepEqual(
          path,
          ["env", "SOURCE_ARCHIVE_KEY"],
          `job ${name} hands the archive key on other than in a step's env`,
        );
        assert.ok(
          !runsNode(job.steps[Number(index)]),
          `job ${name} hands the archive key to a step that runs Node`,
        );
      }
    }
  });

  it("attests and publishes in a job that holds no secret", () => {
    for (const [name, job] of jobs) {
      const publishes = ["id-token", "attestations", "contents"].some(
        (permission) => job.permissions?.[permission] === "write",
      );
      if (publishes) {
        assert.deepEqual(
          [...secretsOf(job)],
          [],
          `job ${name} may publish and holds a secret`,
        );
        assert.equal(
          job.environment,
          undefined,
          `job ${name} may publish and runs in an environment`,
        );
      }
    }
  });

  it("deletes the run's artifacts in a job that runs nothing of the source", () => {
    const deleters = jobs.filter(
      ([, job]) => job.permissions?.actions === "write",
    );
    assert.equal(deleters.length, 1);
    const [[name, job]] = deleters;
    assert.equal(
      job.if,
      "always()",
      `job ${name} skips its cleanup when the run fails`,
    );
    assert.deepEqual(
      [...job.needs].sort(),
      jobs
        .map(([other]) => other)
        .filter((other) => other !== name)
        .sort(),
      `job ${name} may run before every other job has ended`,
    );
    assert.deepEqual([...secretsOf(job)], []);
    assert.ok(
      job.steps.every((step) => step.uses === undefined && !runsNode(step)),
    );
    // What the other jobs report could come from the source's code, so the
    // artifacts are listed from the run instead.
    for (const [text, path] of strings(job.steps)) {
      for (const expression of expressions(text)) {
        assert.doesNotMatch(
          expression,
          /\bneeds\b/i,
          `job ${name} reads another job's output in ${path.join(".")}`,
        );
      }
    }
    const [step] = job.steps;
    assert.match(step.run, /\/actions\/runs\/\$GITHUB_RUN_ID\/artifacts\b/);
    assert.match(step.run, /\[\[ "\$id" =~ \^\[0-9\]\+\$ \]\]/);
  });

  // A workflow copied from another module's release repository keeps that
  // module's paths unless each is changed, and would check, seal or build
  // the wrong one.
  it("names no module of the source but its own", async () => {
    const text = await readFile(new URL("release.yml", workflows), "utf8");
    const named = new Set(
      [...text.matchAll(/\bmodules\/([\w.-]+)/g)].map(([, name]) => name),
    );
    assert.deepEqual([...named], [MODULE]);
  });

  it("sets every job's permissions", () => {
    assert.deepEqual(release.permissions, { contents: "read" });
    for (const [name, job] of jobs) {
      assert.ok(
        job.permissions,
        `job ${name} takes the workflow's permissions`,
      );
    }
  });
});

describe("every workflow", async () => {
  const names = (await readdir(workflows)).filter((name) =>
    /\.ya?ml$/.test(name),
  );

  for (const name of names) {
    const workflow = await read(name);

    it(`${name} pins each action by its full commit id`, () => {
      for (const [text, path] of strings(workflow)) {
        if (path.at(-1) === "uses") {
          assert.match(
            text,
            /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/,
            `${name}: ${path.join(".")}`,
          );
        }
      }
    });

    if (name !== "release.yml") {
      it(`${name} refers to no secret`, () => {
        assert.deepEqual([...secretReferences(workflow)], []);
      });
    }
  }
});
