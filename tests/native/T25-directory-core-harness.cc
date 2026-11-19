#include "../../packages/integrations/sources/native/directory-core.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <string>
#include <unistd.h>

using namespace patrick::directory;

static void require(bool condition, const char* message) {
  if (!condition) {
    std::fprintf(stderr, "%s\n", message);
    std::exit(1);
  }
}

int main() {
#if defined(__APPLE__) && defined(O_NOFOLLOW) && defined(O_CLOEXEC)
  require(geteuid() != 0, "permission fixture requires a non-root effective UID");
  // The test owns cwd and creates every entry used by the harness.
  const int root = open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(root >= 0, "fixture directory open");
  auto read = [&](std::string_view name, size_t limit) {
    return read_component(root, name, limit);
  };
  auto error = [&](std::string_view name, size_t limit, Status status, int code) {
    auto result = read(name, limit);
    require(result.status == status && result.system_error == code && result.bytes.empty(),
            "unexpected failure status, errno or partial bytes");
  };

  int marker = dup(root);
  require(marker >= 0 && close(marker) == 0, "descriptor baseline");
  for (int i = 0; i < 64; ++i) {
    auto result = read("ordinary", 4);
    require(result.status == Status::ok && result.system_error == 0 &&
            result.bytes == std::string("A\0Z\xff", 4), "exact binary contents");
    error("ordinary", 3, Status::too_large, 0);
    error("absent", 4, Status::open_error, ENOENT);
    error("link", 4, Status::open_error, ELOOP);
    error("folder", 4, Status::not_regular, 0);
  }
  const int after = dup(root);
  require(after == marker && close(after) == 0, "descriptor leak or borrowed fd closed");
  for (const std::string& name : {std::string(), std::string("."), std::string(".."),
       std::string("a/b"), std::string("a\\b"), std::string("x\0y", 3), std::string(256, 'a')}) {
    error(name, 4, Status::invalid_component, 0);
  }
  require(read_component(AT_FDCWD, "ordinary", 4).status == Status::invalid_directory_fd,
          "must borrow a real descriptor");
  error("ordinary", max_read_bytes + 1, Status::invalid_limit, 0);
  auto large = read("large", 9000);
  require(large.status == Status::ok && large.bytes == std::string(9000, 'q'), "multiple chunks");
  error("large", 8192, Status::too_large, 0);
  error("denied", 4, Status::open_error, EACCES);
  auto empty = read("empty", 0);
  require(empty.status == Status::ok && empty.bytes.empty(), "zero-byte boundary");
  require(close(root) == 0, "close fixture directory");
  std::puts("fixture passed");
#else
  auto result = read_component(-1, "unused", 1);
  require(result.status == Status::unsupported && result.bytes.empty() &&
          result.system_error == 0, "unsupported contract");
  std::puts("unsupported");
#endif
}
