'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCurrent, cleanup } = require('../scripts/pages.cjs');

function fixture() {
  const context = {
    repo: { owner: 'example', repo: 'paper' }, runId: 20,
    sha: 'current', ref: 'refs/heads/main', payload: { repository: { private: false } },
  };
  const current = {
    workflow_id: 1, path: '.github/workflows/paper.yml', head_branch: 'main',
    head_sha: 'current', event: 'push', run_number: 20,
  };
  const state = {
    sha: 'current', artifacts: [], runs: new Map([[20, current]]), deleted: [], errors: new Map(),
  };
  const core = { notice() {}, info() {}, error() {} };
  const github = {
    rest: {
      git: { getRef: async () => ({ data: { object: { sha: state.sha } } }) },
      actions: {
        getWorkflowRun: async ({ run_id }) => {
          assert.ok(state.runs.has(run_id), 'Unknown run must not be silently accepted');
          return { data: state.runs.get(run_id) };
        },
        listArtifactsForRepo() {},
        deleteArtifact: async ({ artifact_id }) => {
          state.deleted.push(artifact_id);
          if (state.errors.has(artifact_id)) throw state.errors.get(artifact_id);
        },
      },
    },
    paginate: async () => [...state.artifacts],
  };
  function artifact(id, runId = 20, changes = {}) {
    const item = { id, name: 'acpaper-pages', workflow_run: { id: runId }, ...changes };
    state.artifacts.push(item);
    return item;
  }
  return { github, context, core, state, current, artifact };
}

test('first publication accepts the current public main commit', async () => {
  assert.equal(await isCurrent(fixture()), true);
});

test('superseded commits, private repositories, and other branches cannot publish', async () => {
  const f = fixture();
  f.state.sha = 'newer';
  assert.equal(await isCurrent(f), false);
  f.state.sha = 'current';
  f.context.payload.repository.private = true;
  assert.equal(await isCurrent(f), false);
  f.context.payload.repository.private = false;
  f.context.ref = 'refs/heads/draft';
  assert.equal(await isCurrent(f), false);
});

test('cleanup removes the current transport artifact on first publication', async () => {
  const f = fixture();
  f.artifact(100);
  await cleanup(f);
  assert.deepEqual(f.state.deleted, [100]);
});

test('replacement removes previous and current artifacts but preserves unrelated and newer runs', async () => {
  const f = fixture();
  f.state.runs.set(19, { ...f.current, run_number: 19, head_sha: 'older' });
  f.state.runs.set(21, { ...f.current, run_number: 21 });
  f.state.runs.set(30, { ...f.current, workflow_id: 2 });
  f.state.runs.set(31, { ...f.current, head_branch: 'draft' });
  f.state.runs.set(32, { ...f.current, event: 'pull_request' });
  f.artifact(100, 19);
  f.artifact(101);
  f.artifact(102, 21);
  f.artifact(103, 30);
  f.artifact(104, 31);
  f.artifact(105, 32);
  f.artifact(106, 20, { name: 'unrelated' });
  f.artifact(107, 20, { workflow_run: undefined });
  await cleanup(f);
  assert.deepEqual(f.state.deleted, [100, 101]);
});

test('all paginated artifacts are collected before the first deletion', async () => {
  const f = fixture();
  for (let id = 1; id <= 205; id++) f.artifact(id);
  let collected = false;
  f.github.paginate = async (method, params) => {
    assert.equal(params.per_page, 100);
    assert.equal(params.name, 'acpaper-pages');
    collected = true;
    return [...f.state.artifacts];
  };
  const remove = f.github.rest.actions.deleteArtifact;
  f.github.rest.actions.deleteArtifact = async (params) => {
    assert.equal(collected, true);
    await remove(params);
  };
  await cleanup(f);
  assert.equal(f.state.deleted.length, 205);
});

test('cleanup reports failures and still attempts the remaining artifacts', async () => {
  const f = fixture();
  f.artifact(1);
  f.artifact(2);
  f.state.errors.set(1, Object.assign(new Error('Forbidden'), { status: 403 }));
  await assert.rejects(cleanup(f), /Failed to delete 1/);
  assert.deepEqual(f.state.deleted, [1, 2]);
});

test('cleanup is idempotent when an artifact has already disappeared', async () => {
  const f = fixture();
  f.artifact(1);
  f.state.errors.set(1, Object.assign(new Error('Not found'), { status: 404 }));
  await cleanup(f);
  f.state.artifacts = [];
  await cleanup(f);
});

test('unexpected workflow identity fails before deletion', async () => {
  const f = fixture();
  f.artifact(1);
  f.current.path = '.github/workflows/other.yml';
  await assert.rejects(cleanup(f), /Unexpected workflow identity/);
  assert.deepEqual(f.state.deleted, []);
});
