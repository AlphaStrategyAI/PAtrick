#pragma once

#include <cstddef>
#include <string>
#include <string_view>

namespace patrick::directory {

enum class Status {
  ok, unsupported, invalid_directory_fd, invalid_component, invalid_limit,
  open_error, stat_error, not_regular, too_large, read_error, close_error
};

struct Result {
  Status status;
  int system_error;
  std::string bytes;
};

inline constexpr std::size_t max_read_bytes = 1024 * 1024;

// Internal synchronous primitive. Caller owns the directory fd and holds it
// open for the entire call. This interface does not establish authorization.
// A successful close releases this operation's child fd. On close_error
// (including EINTR), the fd's final state is unknown. Do not retry its number
// or use that result to claim release or drain. Cleanup during exception
// unwinding is best effort.
Result read_component(int directory_fd, std::string_view name, std::size_t limit);

}  // namespace patrick::directory
