# carpenterd

Build and compile npm packages to run in the browser. This API is capable of building modules through different build systems. The aim is to have full cross-build-system API that serves a single file to be used in the browser. Note that this API should only be hit from the Design Registry.

##### Build systems

`carpenterd` runs the build as specified on the package. To maximize the developer experience it will use the same configuration you use locally. In any case the result should equal the local build output, with the exception of additional minification, etc. If no build is specified by default an ES6 transpilation will be performed. the The following builds systems are currently available. Minification will only be performed if the `env` is set to `prod`, e.g. for `npm dist-tags 'package@version' prod`.

* _ES6 transpilation:_ will read the `main` file as determined from the package.json and output ES3/5 compliant code. Simple widgets or components composed of a single file will be suited for these types of builds and directly available for web projects. This is also the simplest build system, only the main file

* _Browserify:_ will read the `main` file as determined from the package.json and bundle all modules that are imported/required. Configuration is usually part of any dependant package.json. This build has no explicit configuration, it will simply execute browserify. The complete output file with the CommonJS require wrapper is exposed to BFFS.

* _WebPack:_ will read the webpack configuration file, which is `webpack.config.js` per default. There are no enforced limitation for the config, anything JS goes. However note: the output directory will have to be `./dist` by our convention. All files in the output directory will be published to BFFS.

##### Identification of build system type

Specify a build system in `package.json` with the `build` keyword or use any of the following terms in the keywords:

1. ES6 transpilation: `es2017`, `es2016`, `es2015`, `es6`
2. WebPack: `webpack`
3. Browserify: `browserify`

Alternatively specifying the build system name on the `package.json` with the relative path to the configuration file will also classify the build system, for example: `webpack: '/path/to/config.js'`.

##### Forcefully ignore builds

If a published package should not run any builds at all, provide a `build: false` flag in the package.json.

```json
{
  "name": "package",
  "version": "1.0.0",
  "build": false,
  ...
}
```

Note: the module/package can also be published directly to artifactory. However, if you want to ensure dependants are build whenever your module is publishedthis flag can be useful.

### Install

```
git clone git@github.com/godaddy/carpenterd.git
npm install
```

### Usage

Make sure `BFFS` has a Redis server to run against. Development, staging and test configurations assume this instance is available on the localhost. Without a running redis server builds will not be stored.

```bash
npm start
```

##### Starting Redis

Redis on OSX has to be manually installed and can be started
with the following command.

```bash
redis-server
```

### Tests

Running the tests will require a connection to the GoDaddy VPN or physical connection to the local network. In addition, [Redis](#starting-redis) will have to be running.

```bash
npm test
```

### Configuration

Each environment specifies a different set of default options for the builder. For instance which registry to run `npm install` against. Each build instance has a maximum runtime of `15` minutes. This value can be changed in the configuration.

##### Per build specifications

Variables and specifications required for a build are discerned from a combination of packages.json, build system configuration files and defaults from Carpenters configuration.

**type:** can be supplied as `build` property on the package.json or is extracted from the keywords. Defaults to ES6.

**target:** writes the package and its dependencies to a temporary folder named after `build.id` a unique v4 id. After building this folder is removed from the file system to save disk space.

**env:** Retrieved from the package.json `env` property. This value is provided by the Design Registry.

**version:** read from the package.json `dist-tags.latest`. Has no default.

**name:** Defaults to the package.json `name` property, e.g. the modules name.

**locale:** Uses the locales specified on the package.json and is assigned to the `LANG` env variable for each build. If no locales are specified this defaults to `en-US`.

### API

The API consists of two methods. Running this as an API allows the entire
build process to run independantly as a microservice. `POST` routes only
accept `application/json`.

##### POST /build

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
  "build": "es6",                     // Overrule the build system type.
  "main": "index.jsx",
  "keywords": [                       // Used to differentiate build system type.
    "test",
    "carpenter",
    "es6"
  ],
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

##### GET /cancel/:name/:version/:env?

Parameters:

- *name* {String} Package name.
- *version* {String} Valid semver.
- *env* {String} Optional environment, should either be `dev`, `test`, `prod`
  or `latest`, defaults to `dev`.

**Example:**

```
curl -v http://localhost:1337/cancel/test/0.0.0/dev

GET /cancel/test/0.0.0/dev HTTP/1.1
Host: localhost:1337
User-Agent: curl/7.43.0
Accept: */*

build test@0.0.0 cancelled
```

### wrhs.toml

The files listed here need to be relative of the root project so that they can
be properly read from disk. This gives you more fine tune control over what
source files get returned from us in any given environment.


```toml
[files]
prod = ['dist/js/app.min.js', 'dist/css/app.min.css']
test = ['dist/js/app.js', 'dist/css/app.css']
dev = ['dist/js/app.js', 'dist/css/app.css'];
```

## Tests

```sh
npm test
```

## License
MIT
