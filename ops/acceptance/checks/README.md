One script per issue check. Each gets BASE_URL and SHA; exit 0 only if the FEATURE works (not just that a page loads).
List the batch in a manifest (see example-batch.json) and pass it to prod-deploy as the `manifest` input.
