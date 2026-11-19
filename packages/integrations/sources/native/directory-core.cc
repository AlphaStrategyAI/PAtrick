#include "directory-core.h"

#if defined(__APPLE__)
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cerrno>
#include <utility>

namespace patrick::directory {
#if defined(__APPLE__) && defined(O_NOFOLLOW) && defined(O_CLOEXEC)
namespace {
class OwnedFd {
 public:
  explicit OwnedFd(int fd) : fd_(fd) {}
  OwnedFd(const OwnedFd&) = delete;
  OwnedFd& operator=(const OwnedFd&) = delete;
  ~OwnedFd() {
    if (fd_ >= 0) ::close(fd_);
  }
  int close() { return ::close(std::exchange(fd_, -1)); }
 private:
  int fd_;
};

Result read_regular(int fd, std::size_t limit) {
  struct stat info {};
  if (fstat(fd, &info) == -1) return {Status::stat_error, errno, {}};
  if (!S_ISREG(info.st_mode)) return {Status::not_regular, 0, {}};
  std::string bytes;
  char chunk[8192];
  for (;;) {
    // Read one byte beyond the remaining budget to distinguish EOF at the
    // boundary from truncation. The extra byte is never returned.
    auto remaining = limit - bytes.size();
    auto count = read(fd, chunk, std::min(sizeof(chunk), remaining + 1));
    if (count < 0) {
      if (errno == EINTR) continue;
      return {Status::read_error, errno, {}};
    }
    if (count == 0) return {Status::ok, 0, std::move(bytes)};
    if (static_cast<std::size_t>(count) > remaining) return {Status::too_large, 0, {}};
    bytes.append(chunk, static_cast<std::size_t>(count));
  }
}
}  // namespace
#endif

Result read_component(int directory_fd, std::string_view name, std::size_t limit) {
#if defined(__APPLE__) && defined(O_NOFOLLOW) && defined(O_CLOEXEC)
  if (directory_fd < 0) return {Status::invalid_directory_fd, 0, {}};
  if (name.empty() || name.size() > 255 || name == "." || name == ".." ||
      name.find_first_of("/\\") != name.npos || name.find('\0') != name.npos) {
    return {Status::invalid_component, 0, {}};
  }
  if (limit > max_read_bytes) return {Status::invalid_limit, 0, {}};
  const std::string component(name);
  int fd = openat(directory_fd, component.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY);
  if (fd < 0) return {Status::open_error, errno, {}};
  OwnedFd owned(fd);
  auto result = read_regular(fd, limit);
  if (owned.close() < 0) return {Status::close_error, errno, {}};
  return result;
#else
  (void)directory_fd;
  (void)name;
  (void)limit;
  return {Status::unsupported, 0, {}};
#endif
}
}  // namespace patrick::directory
