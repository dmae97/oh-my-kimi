// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// pi-uutils: Patched for in-process embedding via the shared
// `uu-checksum-common` crate, which redirects all standard stream I/O and file
// resolution through `pi-uutils-ctx`.

uu_checksum_common::declare_standalone!("sha1sum", uucore::checksum::AlgoKind::Sha1);
