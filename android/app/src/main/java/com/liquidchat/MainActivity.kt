package com.liquidchat

import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.liquidchat.platform.LaunchPayload

class MainActivity : ReactActivity() {

  override fun getMainComponentName(): String = "LiquidChat"

  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Routine notification tapped while the app was not running. Captured before React
    // starts so JS can never call consumeLaunchPayload() ahead of it. Skipped on
    // re-creation, where the system would redeliver the original intent.
    if (savedInstanceState == null) LaunchPayload.capture(intent)
    super.onCreate(savedInstanceState)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    // Routine notification tapped while the app was already running (singleTask).
    LaunchPayload.capture(intent)
  }
}
