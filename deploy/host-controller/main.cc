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
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#ifdef PATRICK_SYNTHETIC_REGISTRATION
#include <CommonCrypto/CommonDigest.h>
#else
#include <charconv>
#include <launch.h>
#include <libproc.h>
#include <sys/acl.h>
#include <sys/proc_info.h>
#include <vector>
#endif

namespace {

constexpr int control_fd = 3;

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

bool connect_control(const std::string& path, uid_t owner) {
  sockaddr_un address {};
  if (path.size() >= sizeof(address.sun_path)) return false;
  struct stat endpoint {};
  if (lstat(path.c_str(), &endpoint) != 0 || !S_ISSOCK(endpoint.st_mode) ||
      endpoint.st_uid != owner) return false;
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, path.c_str(), path.size() + 1);
  address.sun_len = SUN_LEN(&address);
  const int socket_fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (socket_fd < 0) return false;
  uid_t peer_uid;
  gid_t peer_gid;
  struct stat observed {};
  if (socket_fd < control_fd || fcntl(socket_fd, F_SETFL, O_NONBLOCK) != 0 ||
      connect(socket_fd, reinterpret_cast<sockaddr*>(&address), address.sun_len) != 0 ||
      getpeereid(socket_fd, &peer_uid, &peer_gid) != 0 || peer_uid != owner ||
      lstat(path.c_str(), &observed) != 0 || !S_ISSOCK(observed.st_mode) ||
      observed.st_uid != owner || observed.st_dev != endpoint.st_dev || observed.st_ino != endpoint.st_ino) {
    close(socket_fd);
    return false;
  }
  if (socket_fd != control_fd) {
    const bool installed = dup2(socket_fd, control_fd) == control_fd;
    if (close(socket_fd) != 0 || !installed) return false;
  }
  return fcntl(control_fd, F_SETFD, 0) == 0;
}

#ifdef PATRICK_SYNTHETIC_REGISTRATION
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
  if (chdir(cwd.c_str()) != 0 || !connect_control(root + "/control.sock", fixture_uid) ||
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

int open_protected(int parent, const char* name, bool directory, mode_t mode = 0) {
  const int fd = openat(parent, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK |
                        (directory ? O_DIRECTORY : 0));
  if (fd < 0) return -1;
  struct stat metadata {};
  if (fstat(fd, &metadata) == 0 && metadata.st_uid == registry_owner &&
      (metadata.st_mode & (S_IWGRP | S_IWOTH | S_ISUID | S_ISGID | S_ISVTX)) == 0 && no_extended_acl(fd) &&
      (mode == 0 || (metadata.st_mode & 07777) == mode) &&
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

struct Supervisor {
  const char* role;
  const char* directory;
  const char* socket_key;
  const char* diagnostic;
  bool require_exact_listener;
};

constexpr Supervisor hub_supervisor {"hub", "hub-supervisor", "HubControl", "HUB", false};
constexpr Supervisor service_supervisor {"service", "service-supervisor", "ServiceControl", "SERVICE", true};
constexpr Supervisor worker_supervisor {"worker", "worker-supervisor", "WorkerControl", "WORKER", true};

bool listener_matches_endpoint(const sockaddr_un& bound, const std::string& path, const struct stat& endpoint) {
  sockaddr_un target {};
  if (path.size() >= sizeof(target.sun_path)) return false;
  if (strncmp(bound.sun_path, path.c_str(), sizeof(bound.sun_path)) == 0) return true;

  const int probe = socket(AF_UNIX, SOCK_STREAM, 0);
  if (probe < 0) return false;
  target.sun_family = AF_UNIX;
  memcpy(target.sun_path, path.c_str(), path.size() + 1);
  target.sun_len = SUN_LEN(&target);
  sockaddr_un peer {};
  socklen_t peer_size = sizeof(peer);
  uid_t peer_uid;
  gid_t peer_gid;
  struct stat observed {};
  const bool matches = fcntl(probe, F_SETFL, O_NONBLOCK) == 0 &&
      connect(probe, reinterpret_cast<sockaddr*>(&target), target.sun_len) == 0 &&
      getpeereid(probe, &peer_uid, &peer_gid) == 0 && peer_uid == registry_owner &&
      getpeername(probe, reinterpret_cast<sockaddr*>(&peer), &peer_size) == 0 && peer.sun_family == AF_UNIX &&
      strncmp(peer.sun_path, bound.sun_path, sizeof(peer.sun_path)) == 0 &&
      lstat(path.c_str(), &observed) == 0 && S_ISSOCK(observed.st_mode) &&
      observed.st_dev == endpoint.st_dev && observed.st_ino == endpoint.st_ino &&
      observed.st_uid == endpoint.st_uid && observed.st_gid == endpoint.st_gid && observed.st_mode == endpoint.st_mode;
  return close(probe) == 0 && matches;
}

bool adopt_supervisor_listener(const Supervisor& supervisor, gid_t group, int target_fd) {
  int* descriptors = nullptr;
  size_t count = 0;
  const int activation = launch_activate_socket(supervisor.socket_key, &descriptors, &count);
  if (activation != 0) {
    fprintf(stderr, "PATRICK_%s_ACTIVATION_FAILED %d\n", supervisor.diagnostic, activation);
    return false;
  }
  if (count != 1) {
    for (size_t index = 0; index < count; ++index) close(descriptors[index]);
    free(descriptors);
    fprintf(stderr, "PATRICK_%s_LISTENER_COUNT_INVALID\n", supervisor.diagnostic);
    return false;
  }
  const int listener = descriptors[0];
  free(descriptors);
  const std::string path = std::string(registry_root) + "/" + supervisor.role + "/supervisor.sock";
  sockaddr_un address {};
  socklen_t address_size = sizeof(address);
  int socket_type = 0;
  socklen_t option_size = sizeof(socket_type);
  struct stat endpoint {};
  const bool admitted_endpoint = lstat(path.c_str(), &endpoint) == 0 && S_ISSOCK(endpoint.st_mode) &&
      endpoint.st_uid == registry_owner && endpoint.st_gid == group &&
      (endpoint.st_mode & 07777) == 0660;
  bool admitted_address = listener >= target_fd &&
      getsockopt(listener, SOL_SOCKET, SO_TYPE, &socket_type, &option_size) == 0 && socket_type == SOCK_STREAM &&
      getsockname(listener, reinterpret_cast<sockaddr*>(&address), &address_size) == 0 &&
      address.sun_family == AF_UNIX && address.sun_path[0] != '\0';
  if (admitted_address && supervisor.require_exact_listener) {
    socket_fdinfo info {};
    admitted_address = proc_pidfdinfo(getpid(), listener, PROC_PIDFDSOCKETINFO, &info, sizeof(info)) == sizeof(info) &&
        (info.psi.soi_options & SO_ACCEPTCONN) != 0 &&
        (!admitted_endpoint || listener_matches_endpoint(address, path, endpoint));
  }
  if (!admitted_address || !admitted_endpoint) {
    close(listener);
    fprintf(stderr, "PATRICK_%s_LISTENER_%s_INVALID\n", supervisor.diagnostic, admitted_address ? "ENDPOINT" : "ADDRESS");
    return false;
  }
  if (listener != target_fd) {
    const bool installed = dup2(listener, target_fd) == target_fd;
    if (close(listener) != 0 || !installed) return false;
  }
  return fcntl(target_fd, F_SETFD, 0) == 0;
}

int launch_supervisor(const Supervisor& config, bool with_worker = false) {
  if (getuid() != registry_owner || geteuid() != registry_owner) return EX_CONFIG;
  const int registry = open_registry();
  if (registry < 0) return EX_CONFIG;
  const int role = open_protected(registry, config.role, true);
  const int supervisor = open_protected(registry, config.directory, true);
  const int worker = with_worker ? open_protected(registry, "worker", true) : -1;
  Account account {};
  Account worker_account {};
  const bool worker_admitted = !with_worker ||
      (worker >= 0 && read_account(worker, worker_account) && has_protected_file(worker, "supervisor-required"));
  const bool admitted = role >= 0 && supervisor >= 0 &&
      read_account(role, account) && distinct_role_accounts(registry, config.role, account.uid) &&
      worker_admitted &&
      has_protected_file(role, "supervisor-required") && has_protected_file(registry, "node") &&
      has_protected_file(supervisor, "entry.mjs") && fchdir(supervisor) == 0;
  const bool closed_role = role < 0 || close(role) == 0;
  const bool closed_supervisor = supervisor < 0 || close(supervisor) == 0;
  const bool closed_worker = worker < 0 || close(worker) == 0;
  if (close(registry) != 0 || !closed_role || !closed_supervisor || !closed_worker || !admitted) {
    fprintf(stderr, "PATRICK_%s_SUPERVISOR_REGISTRATION_INVALID\n", config.diagnostic);
    return EX_CONFIG;
  }
  if (!adopt_supervisor_listener(config, account.gid, control_fd) ||
      (with_worker && !adopt_supervisor_listener(worker_supervisor, worker_account.gid, control_fd + 1))) return EX_CONFIG;
  if (!confine_descriptors(with_worker ? control_fd + 1 : control_fd)) return EX_UNAVAILABLE;

  umask(0077);
  std::string node = std::string(registry_root) + "/node";
  std::string entry = std::string(registry_root) + "/" + config.directory + "/entry.mjs";
  char* argv[] = {node.data(), entry.data(), nullptr};
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", getuid());
  char listener[] = "PATRICK_SUPERVISOR_LISTENER_FD=3";
  char worker_listener[] = "PATRICK_WORKER_LISTENER_FD=4";
  char* envp[] = {encoding, listener, with_worker ? worker_listener : nullptr, nullptr};
  execve(node.c_str(), argv, envp);
  return EX_UNAVAILABLE;
}

int check_role_peer(const char* role) {
  if (getuid() != registry_owner || geteuid() != registry_owner) return EX_CONFIG;
  const int registry = open_registry();
  if (registry < 0) return EX_CONFIG;
  const int directory = open_protected(registry, role, true);
  Account account {};
  const bool admitted = directory >= 0 && read_account(directory, account) &&
                        distinct_role_accounts(registry, role, account.uid);
  const bool closed_directory = directory < 0 || close(directory) == 0;
  if (close(registry) != 0 || !closed_directory || !admitted) return EX_CONFIG;

  sockaddr_storage address {};
  socklen_t address_size = sizeof(address);
  uid_t peer_uid;
  gid_t peer_gid;
  if (getpeername(control_fd, reinterpret_cast<sockaddr*>(&address), &address_size) != 0 ||
      address.ss_family != AF_UNIX || getpeereid(control_fd, &peer_uid, &peer_gid) != 0 ||
      peer_uid != account.uid || peer_gid != account.gid) return EX_CONFIG;
  return EX_OK;
}

int launch_registered_cli(int argc, char** caller_argv) {
  if (getuid() != registry_owner || geteuid() != registry_owner) return EX_CONFIG;
  const int registry = open_registry();
  if (registry < 0) return EX_CONFIG;
  const int directory = open_protected(registry, "cli", true, 0700);
  const int script = directory < 0 ? -1 : open_protected(directory, "entry.mjs", false, 0400);
  const bool admitted = script >= 0 && has_protected_file(registry, "node") && fchdir(directory) == 0;
  const bool closed_script = script < 0 || close(script) == 0;
  const bool closed_directory = directory < 0 || close(directory) == 0;
  if (close(registry) != 0 || !closed_script || !closed_directory || !admitted) {
    fputs("PATRICK_CLI_REGISTRATION_INVALID\n", stderr);
    return EX_CONFIG;
  }
  if (!confine_descriptors(STDERR_FILENO)) return EX_UNAVAILABLE;

  umask(0077);
  std::string node = std::string(registry_root) + "/node";
  std::string entry = std::string(registry_root) + "/cli/entry.mjs";
  std::vector<char*> args {node.data(), entry.data()};
  args.insert(args.end(), caller_argv + 2, caller_argv + argc);
  args.push_back(nullptr);
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", getuid());
  char* envp[] = {encoding, nullptr};
  execve(node.c_str(), args.data(), envp);
  return EX_UNAVAILABLE;
}

int launch_registered_role(const char* role) {
  const int registry = open_registry();
  if (registry < 0) {
    fputs("PATRICK_ROLE_REGISTRY_INVALID\n", stderr);
    return EX_CONFIG;
  }
  const int directory = open_protected(registry, role, true);
  Account account {};
  const bool admitted = directory >= 0 && has_protected_file(registry, "node") &&
                        read_account(directory, account) &&
                        account.uid == getuid() && account.uid == geteuid() &&
                        account.gid == getgid() && account.gid == getegid() &&
                        distinct_role_accounts(registry, role, account.uid) && has_protected_file(directory, "entry.mjs");
  if (!admitted) {
    if (directory < 0) fputs("PATRICK_ROLE_DIRECTORY_INVALID\n", stderr);
    else if (!has_protected_file(registry, "node")) fputs("PATRICK_ROLE_NODE_INVALID\n", stderr);
    else if (!read_account(directory, account)) fputs("PATRICK_ROLE_ACCOUNT_INVALID\n", stderr);
    else if (account.uid != getuid() || account.uid != geteuid() || account.gid != getgid() || account.gid != getegid()) {
      fprintf(stderr, "PATRICK_ROLE_IDENTITY_MISMATCH %u:%u %u:%u\n", account.uid, account.gid, getuid(), getgid());
    } else if (!distinct_role_accounts(registry, role, account.uid)) fputs("PATRICK_ROLE_DISTINCT_INVALID\n", stderr);
    else fputs("PATRICK_ROLE_ENTRY_INVALID\n", stderr);
  }
  close(registry);
  if (!admitted) {
    if (directory >= 0) close(directory);
    return EX_CONFIG;
  }
  const int marker = open_protected(directory, "supervisor-required", false);
  const bool controlled = marker >= 0;
  const bool valid_marker = controlled ? close(marker) == 0 : errno == ENOENT;
  const bool entered = fchdir(directory) == 0;
  if (close(directory) != 0 || !entered) return EX_UNAVAILABLE;
  const std::string role_root = std::string(registry_root) + "/" + role;
  if (!valid_marker) {
    fputs("PATRICK_ROLE_MARKER_INVALID\n", stderr);
    return EX_CONFIG;
  }
  if (controlled && !connect_control(role_root + "/supervisor.sock", registry_owner)) {
    fputs("PATRICK_ROLE_SUPERVISOR_UNAVAILABLE\n", stderr);
    return EX_CONFIG;
  }
  if (!confine_descriptors(controlled ? control_fd : STDERR_FILENO)) return EX_UNAVAILABLE;
  umask(0077);
  std::string node = std::string(registry_root) + "/node";
  std::string entry = role_root + "/entry.mjs";
  char* argv[] = {node.data(), entry.data(), nullptr};
  char encoding[64];
  snprintf(encoding, sizeof(encoding), "__CF_USER_TEXT_ENCODING=0x%X:0x0:0x0", getuid());
  char control[] = "PATRICK_SUPERVISOR_FD=3";
  char* envp[] = {encoding, controlled ? control : nullptr, nullptr};
  execve(node.c_str(), argv, envp);
  return EX_UNAVAILABLE;
}
#endif
}  // namespace
#endif

int main(int argc, char** argv) {
  const bool cli = argc >= 2 && strcmp(argv[1], "run-cli") == 0;
  if (!cli && (argc != 3 ||
      (strcmp(argv[1], "run-role") && strcmp(argv[1], "check-role-peer") && strcmp(argv[1], "run-supervisor")) ||
      (strcmp(argv[2], "service") && strcmp(argv[2], "hub") && strcmp(argv[2], "worker") &&
       (strcmp(argv[1], "run-supervisor") || strcmp(argv[2], "service-with-worker"))))) return EX_USAGE;
#if defined(__APPLE__) && (defined(__arm64__) || defined(__x86_64__))
#ifdef PATRICK_SYNTHETIC_REGISTRATION
  if (cli || strcmp(argv[1], "run-role") || strcmp(argv[2], "service")) return EX_USAGE;
  return launch();
#else
  if (cli) return launch_registered_cli(argc, argv);
  if (strcmp(argv[1], "run-supervisor") == 0) {
    if (strcmp(argv[2], "hub") == 0) return launch_supervisor(hub_supervisor);
    if (strcmp(argv[2], "service") == 0) return launch_supervisor(service_supervisor);
    if (strcmp(argv[2], "service-with-worker") == 0) return launch_supervisor(service_supervisor, true);
    return launch_supervisor(worker_supervisor);
  }
  if (strcmp(argv[1], "check-role-peer") == 0) return check_role_peer(argv[2]);
  return launch_registered_role(argv[2]);
#endif
#else
  return EX_CONFIG;
#endif
}
