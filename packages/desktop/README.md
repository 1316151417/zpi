# @zpi-dev/desktop

ZPI desktop agent workspace with conversations, projects, files, terminals and code review.

Requires Node.js 24. Start the published application with:

```sh
npx @zpi-dev/desktop
```

Or install the command globally:

```sh
npm install --global @zpi-dev/desktop
zpi-desktop
```

Configure your model provider in the application. The npm launcher uses the production `ZPI` data directory, shared with the ZPI desktop application. `ZPI_DATA_DIR` can select a different absolute data directory.

Electron, Sharp and the terminal module are installed as runtime dependencies. End users do not need the ZPI source repository or a local build. npm installation must allow the dependencies' installation scripts so Electron's runtime is downloaded.

Source and documentation: [ZPI](https://github.com/1316151417/zpi).

## Development and release

From the repository root:

```sh
npm run check
npm run test:unit
npm pack --workspace=@zpi-dev/desktop --pack-destination=release/npm
```

The prepack script builds the application and includes its renderer, workers, icons and third-party notices. Only `@zpi-dev/desktop` is published; its internal workspace modules are bundled into the build.
