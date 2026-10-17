package com.liquidchat.platform

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/** Native side of src/platform/android.ts. */
class PlatformPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(
            DeviceContextModule(reactContext),
            CredentialStoreModule(reactContext),
            AlarmSchedulerModule(reactContext),
            NotificationsModule(reactContext),
        )

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}
