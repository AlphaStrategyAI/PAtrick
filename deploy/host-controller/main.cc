#include <cstring>
#include <sysexits.h>

#if defined(__APPLE__) && (defined(__arm64__) || defined(__x86_64__))
#include <cerrno>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <dirent.h>
#include <fcntl.h>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#ifdef PATRICK_SYNTHETIC_REGISTRATION
#include <CommonCrypto/CommonDigest.h>
#include <sys/socket.h>
#include <sys/un.h>
#else
#include <charconv>
#include <sys/acl.h>
#endif

namespace {

// Enumerate the open descriptors themselves. A soft limit need not cover every inherited fd.
bool confine_descriptors(int last_allowed_fd) {
  DIR* directory = opendir("/dev/fd");
  if (!directory) return false;
  bool ok = true;
  while (ok) {
    errno = 0;
    dirent* entry = readdir(directory);
    if (!entry) {
      ok = errno == 0;
      break;
    }
    if (entry->d_name[0] == '.') continue;
    char* end = nullptr;
    long number = strtol(entry->d_name, &end, 10);
    if (errno || *end || number < 0 || number > INT_MAX) {
      ok = false;
      break;
    }
    if (number > last_allowed_fd && number != dirfd(directory)) {
      ok = fcntl(static_cast<int>(number), F_SETFD, FD_CLOEXEC) == 0;
    }
  }
  return closedir(directory) == 0 && ok;
}

#ifdef PATRICK_SYNTHETIC_REGISTRATION
constexpr int control_fd = 3;

bool private_directory(const std::string& path, struct stat& metadata) {
  return lstat(path.c_str(), &metadata) == 0 && S_ISDIR(metadata.st_mode) &&
         metadata.st_uid == fixture_uid && (metadata.st_mode & 07777) == 0700;
}

bool matches_file(const std::string& path, mode_t permissions, const char* expected_sha) {
  int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  if (fd < 0) return false;
  struct stat metadata {};
  bool ok = fstat(fd, &metadata) == 0 && S_ISREG(metadata.st_mode) &&
            metadata.st_uid == fixture_uid && (metadata.st_mode & 07777) == permissions;
  CC_SHA256_CTX hash;
  CC_SHA256_Init(&hash);
  unsigned char buffer[65536];
  while (ok) {
    ssize_t count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) {
      ok = false;
      break;
    }
    CC_SHA256_Update(&hash, buffer, static_cast<CC_LONG>(count));
  }
  if (close(fd) != 0 || !ok) return false;
  unsigned char bytes[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(bytes, &hash);
  char hex[sizeof(bytes) * 2 + 1];
  for (size_t i = 0; i < sizeof(bytes); ++i) {
    snprintf(hex + i * 2, 3, "%02x", static_cast<unsigned>(bytes[i]));
  }
  return strcmp(hex, expected_sha) == 0;
}

bool connect_control(const std::string& path) {
  sockaddr_un address {};
  if (path.size() >= sizeof(address.sun_path)) return false;
  struct stat endpoint {};
  if (lstat(path.c_str(), &endpoint) != 0 || !S_ISSOCK(endpoint.st_mode) ||
      endpoint.st_uid != fixture_uid) return false;
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path.c_str(), path.size() + 1);
  address.sun_len = SUN_LEN(&address);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < control_fd || fcntl(fd, F_SETFL, O_NONBLOCK) != 0 ||
      connect(fd, reinterpret_cast<sockaddr*>(&address), address.sun_len) != 0) return false;
  uid_t peer_uid;
  gid_t peer_gid;
  if (getpeereid(fd, &peer_uid, &peer_gid) != 0 || peer_uid != fixture_uid) return false;
  if (fd != control_fd && (dup2(fd, control_fd) < 0 || close(fd) != 0)) return false;
  return fcntl(control_fd, F_SETFD, 0) == 0;
}

int launch() {
  std::string root = fixture_root;
  std::string node = root + "/node";
  std::string bootstrap = root + "/service-bootstrap.mts";
  std::string cwd = root + "/service";
  std::string home = cwd + "/home";
  char canonical[PATH_MAX];
  struct stat metadata {};
  if (getuid() != fixture_uid || geteuid() != fixture_uid ||
      !realpath(fixture_root, canonical) || root != canonical ||
      !private_directory(root, metadata) || static_cast<unsigned long long>(metadata.st_dev) != fixture_device ||
      metadata.st_ino != fixture_inode || !private_directory(cwd, metadata) ||
      !private_directory(home, metadata) || !matches_file(node, 0500, fixture_node_sha) ||
      !matches_file(bootstrap, 0400, bootstrap_sha)) return EX_CONFIG;
  // The fixture's only writer is its parent. Hash then exec by pathname under this
  // private root does not establish immutable, independently owned production materials.
  umask(0077);
  if (chdir(cwd.c_str()) != 0 || !connect_control(root + "/control.sock") ||
      !confine_descriptors(control_fd)) return EX_UNAVAILABLE;
  char no_addons[] = "--no-addons";
  char* argv[] = {node.data(), no_addons, bootstrap.data(), nullptr};
  std::string home_var = "HOME=" + home;
  // Pin a neutral Darwin text encoding before CoreFoundation initializes the runtime.
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", fixture_uid);
  char* envp[] = {home_var.data(), encoding, nullptr};
  execve(node.c_str(), argv, envp);
  return EX_UNAVAILABLE;
}
#else
#ifndef PATRICK_NATIVE_REGISTRY_TEST
constexpr char registry_root[] = "/Library/Application Support/PAtrick/controller-v1";
constexpr uid_t registry_owner = 0;
#endif

bool no_extended_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == nullptr) return errno == ENOENT;
  acl_entry_t entry;
  errno = 0;
  const bool empty = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == -1 && errno == EINVAL;
  acl_free(acl);
  return empty;
}

int open_protected(int parent, const char* name, bool directory) {
  const int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK |
                        (directory ? O_DIRECTORY : 0));
  if (fd < 0) return -1;
  struct stat metadata {};
  if (fstat(fd, &metadata) == 0 && metadata.st_uid == registry_owner &&
      (metadata.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) == 0 && no_extended_acl(fd) &&
      (directory ? S_ISDIR(metadata.st_mode) : S_ISREG(metadata.st_mode) && metadata.st_nlink == 1)) return fd;
  close(fd);
  errno = EPERM;
  return -1;
}

int open_registry() {
#ifdef PATRICK_NATIVE_REGISTRY_TEST
  return open_protected(AT_FDCWD, registry_root, true);
#else
  int parent = open_protected(AT_FDCWD, "/", true);
  for (const char* component : {"Library", "Application Support", "PAtrick", "controller-v1"}) {
    if (parent < 0) return -1;
    const int child = open_protected(parent, component, true);
    close(parent);
    parent = child;
  }
  return parent;
#endif
}

struct Account {
  uid_t uid;
  gid_t gid;
};

bool read_account(int directory, Account& account) {
  const int fd = open_protected(directory, "account", false);
  if (fd < 0) return false;
  char text[48];
  const ssize_t length = read(fd, text, sizeof(text));
  char trailing;
  const bool complete = length > 0 && read(fd, &trailing, 1) == 0;
  const bool closed = close(fd) == 0;
  if (!closed || !complete || length < 4 || length >= static_cast<ssize_t>(sizeof(text)) || text[length - 1] != '\n') return false;
  const char* end = text + length - 1;
  const auto user = std::from_chars(text, end, account.uid);
  if (user.ec != std::errc{} || user.ptr == end || *user.ptr != ':') return false;
  const auto group = std::from_chars(user.ptr + 1, end, account.gid);
  return group.ec == std::errc{} && group.ptr == end && account.uid != 0;
}

bool distinct_role_accounts(int registry, const char* active_role, uid_t active_uid) {
  uid_t observed[3] = {active_uid};
  size_t count = 1;
  for (const char* role : {"service", "hub", "worker"}) {
    if (strcmp(role, active_role) == 0) continue;
    const int directory = open_protected(registry, role, true);
    if (directory < 0) {
      if (errno == ENOENT) continue;
      return false;
    }
    Account account {};
    const bool admitted = read_account(directory, account);
    if (close(directory) != 0 || !admitted) return false;
    for (size_t index = 0; index < count; ++index) {
      if (observed[index] == account.uid) return false;
    }
    observed[count++] = account.uid;
  }
  return true;
}

bool has_protected_file(int directory, const char* name) {
  const int fd = open_protected(directory, name, false);
  return fd >= 0 && close(fd) == 0;
}

int launch_registered_role(const char* role) {
  const int registry = open_registry();
  if (registry < 0) return EX_CONFIG;
  const int directory = open_protected(registry, role, true);
  Account account {};
  const bool admitted = directory >= 0 && has_protected_file(registry, "node") &&
                        read_account(directory, account) &&
                        account.uid == getuid() && account.uid == geteuid() &&
                        account.gid == getgid() && account.gid == getegid() &&
                        distinct_role_accounts(registry, role, account.uid) && has_protected_file(directory, "entry.mjs");
  close(registry);
  if (!admitted) {
    if (directory >= 0) close(directory);
    return EX_CONFIG;
  }
  const bool entered = fchdir(directory) == 0;
  if (close(directory) != 0 || !entered || !confine_descriptors(STDERR_FILENO)) return EX_UNAVAILABLE;
  umask(0077);
  std::string node = std::string(registry_root) + "/node";
  std::string entry = std::string(registry_root) + "/" + role + "/entry.mjs";
  char* argv[] = {node.data(), entry.data(), nullptr};
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", getuid());
  char* envp[] = {encoding, nullptr};
  execve(node.c_str(), argv, envp);
  return EX_UNAVAILABLE;
}
#endif
}  // namespace
#endif

int main(int argc, char** argv) {
  if (argc != 3 || strcmp(argv[1], "run-role") ||
      (strcmp(argv[2], "service") && strcmp(argv[2], "hub") && strcmp(argv[2], "worker"))) return EX_USAGE;
#if defined(__APPLE__) && (defined(__arm64__) || defined(__x86_64__))
#ifdef PATRICK_SYNTHETIC_REGISTRATION
  if (strcmp(argv[2], "service")) return EX_USAGE;
  return launch();
#else
  return launch_registered_role(argv[2]);
#endif
#else
  return EX_CONFIG;
#endif
}
