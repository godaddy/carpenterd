# `carpenterd`

[![Version npm](https://img.shields.io/npm/v/carpenterd.svg?style=flat-square)](https://www.npmjs.com/package/carpenterd)
[![License](https://img.shields.io/npm/l/carpenterd.svg?style=flat-square)](https://github.com/godaddy/carpenterd/blob/master/LICENSE)
[![npm Downloads](https://img.shields.io/npm/dm/carpenterd.svg?style=flat-square)](https://npmcharts.com/compare/carpenterd?minimal=true)
[![Build Status](https://travis-ci.org/godaddy/carpenterd.svg?branch=master)](https://travis-ci.org/godaddy/carpenterd)
[![Dependencies](https://img.shields.io/david/godaddy/carpenterd.svg?style=flat-square)](https://github.com/godaddy/carpenterd/blob/master/package.json)

Build and compile npm packages to run in the browser. This API is capable of
building modules through different build systems. The aim is to have full
cross-build-system API that serves a single file to be used in the browser.
Note that this API should only be hit from [`warehouse.ai`][warehouse.ai].

## Install

```
git clone git@github.com/godaddy/carpenterd.git
npm install
```

## Usage

Make sure [BFFS] is configured against a running NoSQL database. Development,
staging and test configurations assume this instance is available on the
localhost. Without a database builds will not be stored.

```bash
npm start
```

## API

The API consists of two methods. Running this as an API allows the entire
build process to run independantly as a microservice. `POST` routes only
accept `application/json`.

### POST /build

Trigger a new build for the package specified in the payload. Configuration
properties are merged in with the provided specification. For example the
*registry* that is used to install the package will be merged in. This route
expects a POST payload that is similar to `npm publish`.

**Payload:**

```js
{
  "_id": "test",
  "name": "test",                     // Used as key for storage.
  "description": "A builder test",
  "main": "index.jsx",                // Entry file if not defined in build system.
  "dist-tags": {
    "latest": "0.0.0"                 // Used to extract the version.
  },
  "build": "webpack",                 // Overrule the build system type.
  "main": "index.jsx",
  "_attachments":{
    "test-0.0.0.tgz": {
      "data": "...",                  // base64 encoded tarball of npm pack.
      "length": 665
    }
  }
}
```

The route will stream whiteline delimited JSON as response. The `id` is the
unique *v4* id generated that can also be used to cancel the build.

**Example:**

```
curl -vX POST -H "Content-Type: application/json" -d @payload-0.0.0.json http://localhost:1337/build

Accept: application/json
Accept-Encoding: gzip, deflate
Content-Type: application/json; charset=utf-8
Host: localhost:6064

{"event":"task","message":"start","progress":0,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958247119}
{"event":"task","message":"init","progress":14,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958247120}
{"event":"task","message":"unpack","progress":29,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958247120}
{"event":"task","message":"exists","progress":43,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958248603}
{"event":"task","message":"read","progress":57,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958248605}
{"event":"task","message":"install","progress":72,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958249945}
{"event":"task","message":"assemble","progress":86,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958250210}
{"event":"task","message":"finished","progress":100,"id":"95cf09e6-3a4b-42b2-a3ef-d52b8a3e9ae0","timestamp":1438958250226}
```

## Build systems

`carpenterd` will orchestrate builds as specified in the package. Builds are
distributed to [NSQ]. [`carpenterd-worker` instances][carpenterd-worker]
subscribe to NSQ and perform the actual builds. To maximize the developer
experience it will use the same configuration you use locally. In any case
the result should equal the local build output, with the exception of
additional minification, etc. Minification will only be performed if the
`env` is set to `prod`, e.g. for `npm dist-tags 'package@version' prod`.
The following builds systems are currently available.

* _Browserify:_ will read the `main` file as determined from the
`package.json` and bundle all modules that are imported/required.
Configuration is usually part of any dependant `package.json`. This build
has no explicit configuration, it will simply execute [browserify]. The
complete output file with the CommonJS require wrapper is exposed to [BFFS].

* _Webpack:_ will read the default [webpack] configuration
(`webpack.config.js`). There are no imposed limitations on the configuration.
However, the output directory will have to be `./dist` by our convention.
All files in the output directory will be published to [BFFS].

### Identification of build system type

Specify a build system in `package.json` with the `build` keyword or use
any of the following terms in the keywords:

1. Webpack: `webpack`
2. Browserify: `browserify`

Alternatively specifying the build system name on the `package.json` with
the relative path to the configuration file will also classify the build
system, for example: `webpack: '/path/to/config.js'`.

### Forcefully ignore builds

If a published package should not run any builds at all, provide a
`build: false` flag in the package.json.

```json
{
  "name": "package",
  "version": "1.0.0",
  "build": false,
  ...
}
```

Note: the module/package can also be published directly to a module registry.
However, if you want to ensure dependents are build whenever your module is
published this flag can be useful.

### Configuration

Each environment specifies a different set of default options for the builder.
For instance which registry to run `npm install` against. Each build instance
has a maximum runtime of `15` minutes. This value can be changed in the
configuration.

#### Secure setup

By default `carpenterd` runs as an service over `http` and has no
authentication in place. Setup the configuration to have [Slay] use `https`
and use authentication middleware, for example [authboot].
Store API keys and tokens in an encrypted config with [whisper.json][whisper].

#### Per build specifications

Variables and specifications required for a build are discerned from a
combination of `package.json`, build system configuration files and
defaults from Carpenters configuration.

**type:** can be supplied as `build` property on the package.json or is
extracted from the keywords. Defaults to Webpack.

**target:** writes the package and its dependencies to a temporary folder
named after `build.id` a unique v4 `id`. After building this folder is
removed from the file system to save disk space.

**version:** read from the package.json `dist-tags.latest`. Has no default.

**name:** Defaults to the package.json `name` property, e.g. the modules name.

**locale:** Uses the locales specified on the `package.json`. Each unique
locale triggers a new build. The build will have the environment variables
`LANG` and `LOCALE` set for each build. These values default to `en-US`.

#### wrhs.toml

The files listed here need to be relative of the root project so that they can
be properly read from disk. This gives you more fine tune control over what
files get published to the CDN in any given environment.


```toml
[files]
prod = ['dist/js/app.min.js', 'dist/css/app.min.css']
test = ['dist/js/app.js', 'dist/css/app.css']
dev = ['dist/js/app.js', 'dist/css/app.css'];
```

## Status-Api

Carpenterd supports posting messages to the [warehouse.ai] status-api via [NSQ].
It will post messages to the nsq topic configured at:

```js
{
  // ...other configuration
  "nsq": {
    "statusTopic": "an-nsq-topic", // topic that you choose for the status-api to consume
    // ...other nsq setup
  },
  // ...other configuration
}
```

The [NSQ] payloads will be object that take the form:

```js
{
    eventType: "event|queued|error|ignored", // The type of status event that occurred
    name: "package-name",
    env: "dev", // The environment that is being built
    version: "1.2.3", // The version of the build
    locale: "en-US", // (Optional) The locale that is being built
    buildType: "webpack", // The type of the build (typically just webpack)
    total: 5, // (Optional) The number of builds that were queued
    message: "Description of what happened"
  }
```

### Event Types

In the status-api NSQ payload there is a field called `eventType`.
The possible values that carpenterd will send are:

- `event` - Used for interim statuses that a user might care about,
  but doesn't affect/progress the overall build status
- `queued` - Used to indicated how many builds were queued with
  `carpenter-worker`
- `error` - Used to indicate that `carpenterd` encountered an error and wasn't
  able to queue all the builds
- `ignored` - Used to indicate that the build was ignored and no builds were
  queued.  Typically this is because the package was not configured to have a
  build or was set to not build.

## Tests

Run an AWS local cloud stack, pull `latest` [localstack].
This requires `docker` [to be setup][docker].

```sh
docker pull localstack/localstack:latest
npm run localstack
```

Run tests in a separate terminal.

```sh
npm test
```

[warehouse.ai]: https://github.com/godaddy/warehouse.ai
[NSQ]: https://github.com/nsqio/nsq
[BFFS]: https://github.com/warehouseai/bffs
[webpack]: https://webpack.js.org/
[carpenterd-worker]: https://github.com/godaddy/carpenterd-worker
[Slay]: https://github.com/godaddy/slay
[authboot]: https://github.com/warehouseai/authboot
[whisper]: https://github.com/jcrugzz/whisper.json
[browserify]: http://browserify.org/
[Babel]: https://babeljs.io/
[docker]: https://docs.docker.com/get-started/
