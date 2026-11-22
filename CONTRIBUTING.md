# Contributing

Thanks for helping. Bug reports, test cases and fixes are all welcome.

## Reporting a bug

Open a GitHub issue and fill in the template. Please do not paste anything private: Morph's logs contain no clipboard content, but check before you share them.

## Working on the code

- `daemon/core.js` holds the logic and `daemon/gjs-main.js` the GNOME program. `gnome-extension/` is the helper that draws the pill. `src/core/` and `lib/` do the format conversion.
- Run all tests with `node test/run-all.js`. They must pass before you open a pull request.
- Add a test for every fix or feature. Test data must be made up: no real names, emails, hosts or file names.
- Keep changes small and focused, and keep the wording in the interface plain and honest.

## Licensing of contributions

By opening a pull request you agree that your contribution is licensed under the same terms as the project (see [LICENSE](LICENSE)), and that you have the right to contribute it.
