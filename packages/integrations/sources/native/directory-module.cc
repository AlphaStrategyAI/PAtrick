#include <node_api.h>

namespace {

bool checked(napi_env env, napi_status status) {
  if (status == napi_ok) return true;
  if (status != napi_pending_exception) {
    const napi_status thrown = napi_throw_error(env, nullptr, "directory module Node-API call failed");
    if (thrown != napi_ok && thrown != napi_pending_exception) {
      napi_fatal_error("directory module", NAPI_AUTO_LENGTH, "could not report Node-API failure", NAPI_AUTO_LENGTH);
    }
  }
  return false;
}

napi_value module_info(napi_env env, napi_callback_info callback) {
  size_t argc = 1;
  napi_value argument;
  if (!checked(env, napi_get_cb_info(env, callback, &argc, &argument, nullptr, nullptr))) return nullptr;
  if (argc != 0) {
    checked(env, napi_throw_type_error(env, nullptr, "moduleInfo takes no arguments"));
    return nullptr;
  }

  napi_value result, format, interface_version, napi_version;
  if (!checked(env, napi_create_object(env, &result)) ||
      !checked(env, napi_create_string_utf8(env, "patrick-directory-module", NAPI_AUTO_LENGTH, &format)) ||
      !checked(env, napi_create_uint32(env, 1, &interface_version)) ||
      !checked(env, napi_create_uint32(env, NAPI_VERSION, &napi_version))) return nullptr;

  const napi_property_descriptor fields[] = {
      {"format", nullptr, nullptr, nullptr, nullptr, format, napi_default_jsproperty, nullptr},
      {"interfaceVersion", nullptr, nullptr, nullptr, nullptr, interface_version, napi_default_jsproperty, nullptr},
      {"napiVersion", nullptr, nullptr, nullptr, nullptr, napi_version, napi_default_jsproperty, nullptr},
  };
  if (!checked(env, napi_define_properties(env, result, 3, fields))) return nullptr;
  return result;
}

}  // namespace

NAPI_MODULE_INIT() {
  const napi_property_descriptor method = {
      "moduleInfo", nullptr, module_info, nullptr, nullptr, nullptr, napi_default_method, nullptr};
  if (!checked(env, napi_define_properties(env, exports, 1, &method))) return nullptr;
  return exports;
}
