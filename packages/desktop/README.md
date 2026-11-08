# @zpi-dev/desktop

ZPI desktop agent workspace with conversations, projects, files, terminals and code review.

Requires Node.js 24. Windows is not supported; the desktop application is primarily validated on macOS Apple Silicon. This restriction applies to the desktop package only; `@zpi-dev/agent-sdk` remains cross-platform, including Windows.

We recommend starting the published application with npx:

```sh
npx @zpi-dev/desktop
```

Or install the command globally:

```sh
npm install --global @zpi-dev/desktop
zpi-desktop
```

Configure your model provider in the application. The npm launcher uses the production `ZPI` data directory. `ZPI_DATA_DIR` can select a different absolute data directory.

Electron, Sharp and the terminal module are installed as runtime dependencies. End users do not need the ZPI source repository or a local build. npm installation must allow the dependencies' installation scripts so Electron's runtime is downloaded.

Source and documentation: [ZPI](https://github.com/1316151417/zpi).

## Update

Quit the application and back up its data before updating. Run `npx @zpi-dev/desktop@latest`, or update the global command with `npm install --global @zpi-dev/desktop@latest` and run `zpi-desktop`.

## Development and npm publishing

From the repository root:

```sh
npm run check
npm run test:unit
npm pack --workspace=@zpi-dev/desktop --pack-destination=release/npm
```

The prepack script builds the application and includes its renderer, workers, icons and third-party notices. Only `@zpi-dev/desktop` is published; its internal workspace modules are bundled into the build.
