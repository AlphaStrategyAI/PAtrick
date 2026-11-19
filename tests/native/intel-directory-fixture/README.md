# Intel diagnostic input fixture

This directory is only for an offline test. The manifest records the reviewed
module source, four official Node 24.9.0 header member digests, three private
standard headers and one ABI assertion header. The archive fields record how
the member pins were derived; this helper does not read or verify an archive.

`stageApprovedInputs(entries, parent)` accepts exactly nine pre-extracted
byte arrays. It checks the reviewed manifest, copies and hashes all inputs,
and stages those copies under a new private child of a test-owned `0700`
directory. It creates fixed paths only. The caller owns and removes a returned
directory. A failed write removes the new child or reports that cleanup failed.
The synthetic entry point accepts alternate hashes only for tests; it uses the
same fixed names and destinations and is not used by the approved wrapper.

The parent and process must already be trusted and private. These path-based
operations are not a defense against another actor with the same filesystem
authority. A future tool must independently prove which staged bytes it uses.
No archive extraction, compiler, linker, native module, production reader,
toolchain approval, signing or release is provided here. The small
headers and ABI assertions have not been compiled or accepted as an SDK.
