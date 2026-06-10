# Third-party attribution — RTK

Portions of the shell-output minimizer adapt algorithms from **RTK**
(`rtk-ai/rtk`), used under the MIT License, which is compatible with this
workspace's MIT License.

## Ported component

- **Upstream:** [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) @ commit
  `878af7de99e0ba71da2e8fd996f6b52a1836e06c`
- **Upstream path:** `src/cmds/python/pytest_cmd.rs`
- **Local path:** `crates/pi-shell/src/minimizer/filters/python.rs`
- **What was adapted:** the `build_pytest_summary` algorithm — re-implemented
  here as the pytest state machine (`filter_pytest`, `pytest_success`,
  `is_pytest_*`, `looks_like_pytest_summary_part`). It preserves failures,
  errors, and the final summary line; strips header framing, progress dots, and
  verbose `PASSED` rows; and falls through unchanged on unknown-state lines
  (RTK's defensive default) so xdist `[gwN]` prefixes and custom reporters never
  cause data loss.

## License (MIT)

RTK is distributed under the MIT License. A copy of the upstream license text
is reproduced below for the pinned revision above.

```
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
