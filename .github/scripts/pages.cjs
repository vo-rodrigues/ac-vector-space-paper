'use strict';

const ARTIFACT_NAME = 'acpaper-pages';
const WORKFLOW_PATH = '.github/workflows/paper.yml';

async function isCurrent({ github, context, core }) {
  if (context.ref !== 'refs/heads/main' || context.payload.repository.private !== false) {
    return false;
  }
  const { data: ref } = await github.rest.git.getRef({
    ...context.repo,
    ref: 'heads/main',
  });
  const current = ref.object.sha === context.sha;
  if (!current) core.notice('A newer main commit exists; this PDF will not be published.');
  return current;
}

async function cleanup({ github, context, core }) {
  if (context.ref !== 'refs/heads/main' || context.payload.repository.private !== false) {
    throw new Error('Artifact cleanup is restricted to public main builds.');
  }
  const params = context.repo;
  const { data: currentRun } = await github.rest.actions.getWorkflowRun({
    ...params,
    run_id: context.runId,
  });
  if (currentRun.path !== WORKFLOW_PATH || currentRun.head_branch !== 'main' ||
      currentRun.head_sha !== context.sha) {
    throw new Error('Unexpected workflow identity; refusing artifact deletion.');
  }

  // Gather every page before deleting: removing entries while paginating can
  // shift subsequent pages and leave old artifacts behind.
  const artifacts = await github.paginate(github.rest.actions.listArtifactsForRepo, {
    ...params,
    name: ARTIFACT_NAME,
    per_page: 100,
  });
  const runs = new Map([[context.runId, currentRun]]);
  const candidates = [];
  for (const artifact of artifacts) {
    const runId = artifact.workflow_run?.id;
    if (artifact.name !== ARTIFACT_NAME || !runId) continue;
    if (!runs.has(runId)) {
      const { data: run } = await github.rest.actions.getWorkflowRun({ ...params, run_id: runId });
      runs.set(runId, run);
    }
    const run = runs.get(runId);
    if (run.workflow_id === currentRun.workflow_id && run.path === WORKFLOW_PATH &&
        run.head_branch === 'main' && ['push', 'workflow_dispatch'].includes(run.event) &&
        run.run_number <= currentRun.run_number) {
      candidates.push(artifact);
    }
  }

  let failures = 0;
  for (const artifact of candidates) {
    try {
      await github.rest.actions.deleteArtifact({ ...params, artifact_id: artifact.id });
      core.info(`Deleted temporary PDF artifact ${artifact.id}.`);
    } catch (error) {
      // Already absent is the desired result; permission/server errors are not.
      if (error.status === 404) continue;
      failures += 1;
      core.error(`Could not delete artifact ${artifact.id}: ${error.message}`);
    }
  }
  if (failures) throw new Error(`Failed to delete ${failures} temporary PDF artifact(s).`);
  core.info(`Cleanup completed for ${candidates.length} temporary PDF artifact(s).`);
}

module.exports = { isCurrent, cleanup };
