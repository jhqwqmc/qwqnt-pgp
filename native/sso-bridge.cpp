#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <string.h>

using Env = void*;
using Value = void*;
using Status = int;
using CreateString = Status (*)(Env, const char*, size_t, Value*);
using ReadString = Status (*)(Env, Value, char*, size_t, size_t*);
using Coerce = Status (*)(Env, Value, Value*);
using BufferInfo = Status (*)(Env, Value, void**, size_t*);
using BufferCopy = Status (*)(Env, size_t, const void*, void**, Value*);
using IsBuffer = Status (*)(Env, Value, bool*);
using SetProperty = Status (*)(Env, Value, const char*, Value);

static CreateString utf8, latin1;
static ReadString readUtf8, readLatin1;
static Coerce coerce;
static BufferInfo bufferInfo;
static BufferCopy bufferCopy;
static IsBuffer isBuffer;
static SetProperty setProperty;
static uintptr_t sendBegin, sendEnd, replyReturn;
static thread_local Env requestEnv;
static thread_local Value requestString;
static thread_local Env replyEnv;
static thread_local Value replyString, replyBytes;

static Status convertRequest(Env env, Value value, Value* output) {
    const auto caller = reinterpret_cast<uintptr_t>(__builtin_return_address(0));
    bool binary = false;
    if (caller >= sendBegin && caller < sendEnd && !isBuffer(env, value, &binary) && binary) {
        void* data = nullptr;
        size_t length = 0;
        const auto status = bufferInfo(env, value, &data, &length);
        if (status) return status;
        const auto result = latin1(env, length ? static_cast<const char*>(data) : "", length, output);
        if (!result) {
            requestEnv = env;
            requestString = *output;
        }
        return result;
    }
    return coerce(env, value, output);
}

static Status readRequest(Env env, Value value, char* data, size_t size, size_t* length) {
    if (env == requestEnv && value == requestString) {
        if (data) {
            requestEnv = nullptr;
            requestString = nullptr;
        }
        return readLatin1(env, value, data, size, length);
    }
    return readUtf8(env, value, data, size, length);
}

static Status createReply(Env env, const char* data, size_t length, Value* output) {
    const auto caller = reinterpret_cast<uintptr_t>(__builtin_return_address(0));
    const auto status = utf8(env, data, length, output);
    if (caller == replyReturn && !status && length != SIZE_MAX) {
        replyEnv = env;
        replyString = *output;
        replyBytes = nullptr;
        bufferCopy(env, length, length ? data : "", nullptr, &replyBytes);
    }
    return status;
}

static Status setReplyProperty(Env env, Value object, const char* name, Value value) {
    const auto status = setProperty(env, object, name, value);
    if (env == replyEnv && value == replyString && name && strcmp(name, "rsp") == 0) {
        const auto bytes = replyBytes;
        replyEnv = nullptr;
        replyString = replyBytes = nullptr;
        if (!status && bytes) setProperty(env, object, "rspBuffer", bytes);
    }
    return status;
}

struct Import {
    void** slot = nullptr;
    HMODULE library = nullptr;
};

static Import findImport(uint8_t* module, const IMAGE_NT_HEADERS64& headers, const char* name) {
    const auto directory = headers.OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
    if (!directory.VirtualAddress) return {};
    const auto descriptors = reinterpret_cast<const IMAGE_IMPORT_DESCRIPTOR*>(module + directory.VirtualAddress);
    for (auto d = descriptors; d->Name; ++d) {
        if (!d->OriginalFirstThunk) continue;
        const auto names = reinterpret_cast<const IMAGE_THUNK_DATA64*>(module + d->OriginalFirstThunk);
        auto slots = reinterpret_cast<void**>(module + d->FirstThunk);
        for (size_t i = 0; names[i].u1.AddressOfData; ++i) {
            const auto rva = names[i].u1.AddressOfData;
            if (IMAGE_SNAP_BY_ORDINAL64(rva)) continue;
            const auto info = reinterpret_cast<const IMAGE_IMPORT_BY_NAME*>(module + rva);
            if (strcmp(reinterpret_cast<const char*>(info->Name), name) == 0) {
                return { slots + i, GetModuleHandleA(reinterpret_cast<const char*>(module + d->Name)) };
            }
        }
    }
    return {};
}

static bool replace(void** slot, void* value) {
    DWORD previous = 0;
    if (!VirtualProtect(slot, sizeof(*slot), PAGE_READWRITE, &previous)) return false;
    InterlockedExchangePointer(slot, value);
    DWORD ignored = 0;
    VirtualProtect(slot, sizeof(*slot), previous, &ignored);
    return true;
}

static uintptr_t locateReplyCall(uint8_t* start, size_t length, void** target) {
    uintptr_t reply = 0;
    unsigned calls = 0;
    for (size_t i = 0; i + 6 <= length; ++i) {
        if (start[i] != 0xff || start[i + 1] != 0x15) continue;
        int32_t displacement = 0;
        memcpy(&displacement, start + i + 2, sizeof(displacement));
        const auto next = reinterpret_cast<uintptr_t>(start + i + 6);
        if (next + displacement != reinterpret_cast<uintptr_t>(target)) continue;
        ++calls;
        reply = next;
    }
    return calls == 2 ? reply : 0;
}

static bool install(uint8_t* module, DWORD send, DWORD recv) {
    if (!module || send == recv) return false;
    const auto dos = reinterpret_cast<const IMAGE_DOS_HEADER*>(module);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    const auto headers = reinterpret_cast<const IMAGE_NT_HEADERS64*>(module + dos->e_lfanew);
    if (headers->Signature != IMAGE_NT_SIGNATURE || headers->FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64) return false;
    if (send >= headers->OptionalHeader.SizeOfImage || recv >= headers->OptionalHeader.SizeOfImage) return false;
    DWORD64 image = 0;
    const auto sendFunction = RtlLookupFunctionEntry(reinterpret_cast<DWORD64>(module + send), &image, nullptr);
    if (!sendFunction || image != reinterpret_cast<DWORD64>(module) || sendFunction->BeginAddress != send) return false;
    const auto recvFunction = RtlLookupFunctionEntry(reinterpret_cast<DWORD64>(module + recv), &image, nullptr);
    if (!recvFunction || image != reinterpret_cast<DWORD64>(module) || recvFunction->BeginAddress != recv) return false;

    const auto c = findImport(module, *headers, "napi_coerce_to_string");
    const auto r = findImport(module, *headers, "napi_get_value_string_utf8");
    const auto w = findImport(module, *headers, "napi_create_string_utf8");
    const auto s = findImport(module, *headers, "napi_set_named_property");
    if (!c.slot || !r.slot || !w.slot || !w.library || !s.slot) return false;
    replyReturn = locateReplyCall(module + recv, recvFunction->EndAddress - recv, w.slot);
    if (!replyReturn) return false;
    coerce = reinterpret_cast<Coerce>(*c.slot);
    readUtf8 = reinterpret_cast<ReadString>(*r.slot);
    utf8 = reinterpret_cast<CreateString>(*w.slot);
    setProperty = reinterpret_cast<SetProperty>(*s.slot);
    latin1 = reinterpret_cast<CreateString>(GetProcAddress(w.library, "napi_create_string_latin1"));
    readLatin1 = reinterpret_cast<ReadString>(GetProcAddress(w.library, "napi_get_value_string_latin1"));
    bufferInfo = reinterpret_cast<BufferInfo>(GetProcAddress(w.library, "napi_get_buffer_info"));
    bufferCopy = reinterpret_cast<BufferCopy>(GetProcAddress(w.library, "napi_create_buffer_copy"));
    isBuffer = reinterpret_cast<IsBuffer>(GetProcAddress(w.library, "napi_is_buffer"));
    if (!coerce || !readUtf8 || !utf8 || !setProperty || !latin1 || !readLatin1 || !bufferInfo || !bufferCopy || !isBuffer) return false;
    sendBegin = reinterpret_cast<uintptr_t>(module + send);
    sendEnd = reinterpret_cast<uintptr_t>(module + sendFunction->EndAddress);
    if (!replace(r.slot, reinterpret_cast<void*>(readRequest))) return false;
    if (!replace(s.slot, reinterpret_cast<void*>(setReplyProperty))) {
        replace(r.slot, reinterpret_cast<void*>(readUtf8));
        return false;
    }
    if (!replace(w.slot, reinterpret_cast<void*>(createReply))) {
        replace(s.slot, reinterpret_cast<void*>(setProperty));
        replace(r.slot, reinterpret_cast<void*>(readUtf8));
        return false;
    }
    if (!replace(c.slot, reinterpret_cast<void*>(convertRequest))) {
        replace(w.slot, reinterpret_cast<void*>(utf8));
        replace(s.slot, reinterpret_cast<void*>(setProperty));
        replace(r.slot, reinterpret_cast<void*>(readUtf8));
        return false;
    }
    return true;
}

using Callback = Value (*)(Env, void*);
using GetArgs = Status (*)(Env, void*, size_t*, Value*, Value*, void**);
using ReadUInt = Status (*)(Env, Value, uint32_t*);
using ReadWide = Status (*)(Env, Value, char16_t*, size_t, size_t*);
using GetBool = Status (*)(Env, bool, Value*);
using CreateFunction = Status (*)(Env, const char*, size_t, Callback, void*, Value*);
static GetArgs getArgs;
static ReadUInt readUInt;
static ReadWide readWide;
static GetBool getBool;

static Value attach(Env env, void* info) {
    Value args[3]{};
    size_t count = 3;
    uint32_t send = 0, recv = 0;
    static bool installed = false;
    if (!installed && !getArgs(env, info, &count, args, nullptr, nullptr) && count == 3 &&
        !readUInt(env, args[0], &send) && !readUInt(env, args[1], &recv)) {
        size_t length = 0;
        if (!readWide(env, args[2], nullptr, 0, &length) && length && length <= 32767) {
            const auto heap = GetProcessHeap();
            const size_t capacity = length + 1;
            const auto path = static_cast<wchar_t*>(HeapAlloc(heap, 0, capacity * sizeof(wchar_t)));
            if (path) {
                if (!readWide(env, args[2], reinterpret_cast<char16_t*>(path), capacity, &length)) {
                    const auto module = reinterpret_cast<uint8_t*>(GetModuleHandleW(path));
                    installed = install(module, send, recv);
                }
                HeapFree(heap, 0, path);
            }
        }
    }
    Value result = nullptr;
    getBool(env, installed, &result);
    return result;
}

extern "C" __declspec(dllexport) Value napi_register_module_v1(Env env, Value exports) {
    auto host = GetModuleHandleW(L"QQNT.dll");
    if (!host) host = GetModuleHandleW(nullptr);
    getArgs = reinterpret_cast<GetArgs>(GetProcAddress(host, "napi_get_cb_info"));
    readUInt = reinterpret_cast<ReadUInt>(GetProcAddress(host, "napi_get_value_uint32"));
    readWide = reinterpret_cast<ReadWide>(GetProcAddress(host, "napi_get_value_string_utf16"));
    getBool = reinterpret_cast<GetBool>(GetProcAddress(host, "napi_get_boolean"));
    const auto create = reinterpret_cast<CreateFunction>(GetProcAddress(host, "napi_create_function"));
    const auto set = reinterpret_cast<SetProperty>(GetProcAddress(host, "napi_set_named_property"));
    Value function = nullptr;
    if (getArgs && readUInt && readWide && getBool && create && set && !create(env, "attach", 6, attach, nullptr, &function)) {
        set(env, exports, "attach", function);
    }
    return exports;
}
