# Project guidance

## npm releases

- Prefer Bun for packaging and publishing. After a successful publish, do not publish the same version again just because npm still shows **Validating** or a public registry response shows the previous version.
- Verify the uploaded version and tag with `npm view opencode-raven@<version> version dist-tags.latest --prefer-online --json`. Using npm for this verification is appropriate even when Bun performed the publish.
- Registry reads can lag during validation or propagation. In the 2.3.8 release, Bun reported success while public registry reads initially showed 2.3.7; a redundant npm publish then failed because 2.3.8 already existed.
- If npm says the version was already published, do not retry publication or bump the version to work around the delay. Check registry metadata and validation status instead.
- Distinguish **uploaded, validation pending** from **verified available as latest** in status updates. If validation is pending, report it and allow time for completion rather than repeatedly polling or republishing.
