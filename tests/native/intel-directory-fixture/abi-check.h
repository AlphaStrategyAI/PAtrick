#ifndef PATRICK_TEST_INTEL_ABI_CHECK_H
#define PATRICK_TEST_INTEL_ABI_CHECK_H

// These checks describe one diagnostic fixture, not an approved platform ABI.
#if !defined(__cplusplus) || !defined(__APPLE__) || !defined(__MACH__) || !defined(__x86_64__) || !defined(__LP64__)
#error "This fixture requires Darwin x86_64 C++ LP64"
#endif
#if !defined(__BYTE_ORDER__) || !defined(__ORDER_LITTLE_ENDIAN__)
#error "This fixture requires explicit byte-order macros"
#endif
#if __CHAR_BIT__ != 8 || __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "This fixture requires eight-bit little-endian bytes"
#endif
#if NAPI_VERSION != 8
#error "This fixture requires Node-API version 8"
#endif

#include <node_api.h>

template <typename A, typename B> struct patrick_fixture_same { static constexpr bool value = false; };
template <typename A> struct patrick_fixture_same<A, A> { static constexpr bool value = true; };
using patrick_fixture_function = void (*)();
static_assert(patrick_fixture_same<size_t, unsigned long>::value, "size_t type");
static_assert(sizeof(size_t) == 8 && alignof(size_t) == 8 && SIZE_MAX == size_t(-1), "size_t layout");
static_assert(sizeof(void*) == 8 && alignof(void*) == 8, "object pointer layout");
static_assert(sizeof(patrick_fixture_function) == 8 && alignof(patrick_fixture_function) == 8, "function pointer layout");
static_assert(sizeof(bool) == 1 && sizeof(char16_t) == 2, "built-in character layout");
static_assert(sizeof(int8_t) == 1 && int8_t(-1) < int8_t(0) && sizeof(uint8_t) == 1 && uint8_t(-1) > uint8_t(0), "8-bit integers");
static_assert(sizeof(int16_t) == 2 && int16_t(-1) < int16_t(0) && sizeof(uint16_t) == 2 && uint16_t(-1) > uint16_t(0), "16-bit integers");
static_assert(sizeof(int32_t) == 4 && int32_t(-1) < int32_t(0) && sizeof(uint32_t) == 4 && uint32_t(-1) > uint32_t(0), "32-bit integers");
static_assert(sizeof(int64_t) == 8 && int64_t(-1) < int64_t(0) && sizeof(uint64_t) == 8 && uint64_t(-1) > uint64_t(0), "64-bit integers");
static_assert(sizeof(napi_status) == 4 && sizeof(napi_property_attributes) == 4, "Node-API enum layout");
static_assert(sizeof(napi_property_descriptor) == 64 && alignof(napi_property_descriptor) == 8, "descriptor layout");
static_assert(__builtin_offsetof(napi_property_descriptor, utf8name) == 0, "descriptor utf8name");
static_assert(__builtin_offsetof(napi_property_descriptor, name) == 8, "descriptor name");
static_assert(__builtin_offsetof(napi_property_descriptor, method) == 16, "descriptor method");
static_assert(__builtin_offsetof(napi_property_descriptor, getter) == 24, "descriptor getter");
static_assert(__builtin_offsetof(napi_property_descriptor, setter) == 32, "descriptor setter");
static_assert(__builtin_offsetof(napi_property_descriptor, value) == 40, "descriptor value");
static_assert(__builtin_offsetof(napi_property_descriptor, attributes) == 48, "descriptor attributes");
static_assert(__builtin_offsetof(napi_property_descriptor, data) == 56, "descriptor data");
static_assert(NAPI_AUTO_LENGTH == SIZE_MAX, "automatic length");

#endif
