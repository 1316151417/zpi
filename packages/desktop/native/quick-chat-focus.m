#import <AppKit/AppKit.h>
#include <node_api.h>

static void releaseTarget(napi_env env, void *data, void *hint) {
  CFRelease(data);
}

static napi_value returnFocus(napi_env env, napi_callback_info info) {
  void *data = NULL;
  napi_get_cb_info(env, info, NULL, NULL, NULL, &data);
  NSRunningApplication *target = (__bridge NSRunningApplication *)data;
  BOOL restored = NO;
  // Do not steal focus if the user already clicked another window, or launch
  // an app that has since quit. Holding the object also avoids PID reuse.
  @try {
    if (NSApp.active && target && !target.terminated) {
      if (@available(macOS 14.0, *)) [NSApp yieldActivationToApplication:target];
      restored = [target activateWithOptions:NSApplicationActivateIgnoringOtherApps];
    }
  } @catch (NSException *exception) {
    napi_throw_error(env, NULL, exception.reason.UTF8String);
    return NULL;
  }
  napi_value result;
  napi_get_boolean(env, restored, &result);
  return result;
}

static napi_value activate(napi_env env, napi_callback_info info) {
  napi_value result;
  NSRunningApplication *previous = NSWorkspace.sharedWorkspace.frontmostApplication;
  @try {
    [NSApp activateIgnoringOtherApps:YES];
  } @catch (NSException *exception) {
    napi_throw_error(env, NULL, exception.reason.UTF8String);
    return NULL;
  }
  if (!previous || previous.processIdentifier == NSProcessInfo.processInfo.processIdentifier) {
    napi_get_undefined(env, &result);
    return result;
  }
  void *target = (void *)CFBridgingRetain(previous);
  if (napi_create_function(env, "returnFocus", NAPI_AUTO_LENGTH, returnFocus, target, &result) != napi_ok) {
    CFRelease(target);
    return NULL;
  }
  napi_add_finalizer(env, result, target, releaseTarget, NULL, NULL);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "activate", NAPI_AUTO_LENGTH, activate, NULL, &function);
  napi_set_named_property(env, exports, "activate", function);
  return exports;
}
