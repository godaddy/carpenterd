# CHANGELOG

- [#60] Use DynamoDB based models.

### 5.1.0

- Use updated `nsq.js-k8` to get built in retries on publish

### 5.0.0

- Make retryable write-stream for writing with status-writer

- [#47] Update `README.md`
  - Provide links to relevant projects and modules
  - Add badges
  - Update minor and patch versions of dependencies to resolve security warnings
- [#46] Default documenation
  - Add: `CONTRUBUTING.md`, `SECURITY.md`
  - update `LICENSE` year
  - add `.github` templates
  - Give credits for Github templates

### 4.0.0

- [#42] Extract config
  - `async/await` conversion
  - Preparing for `@wrhs/extract-config`'s eager use of config

- [#40] Modernize files
  - `prototype` over `class`
  - Use arrow functions

### 2.6.0

- Add timing information to status nsq messages
- Add additional status nsq messages for unpack, pack, upload
- Allow for `npm install` retries in nsq status messages

### 2.3.1

- [#33] Default `this.target` and use it as the default for `this.rootDir`.

[#46]: https://github.com/godaddy/carpenterd/pull/46
[#47]: https://github.com/godaddy/carpenterd/pull/47
[#60]: https://github.com/godaddy/carpenterd/pull/60

