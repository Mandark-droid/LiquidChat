package com.liquidchat

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import org.json.JSONArray
import org.json.JSONObject

class LiquidChatAccessibilityService : AccessibilityService() {

    companion object {
        const val ACTION_PERFORM = "com.liquidchat.ACCESSIBILITY_PERFORM"
        const val ACTION_RESULT = "com.liquidchat.ACCESSIBILITY_RESULT"
        var instance: LiquidChatAccessibilityService? = null
            private set
    }

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val json = intent.getStringExtra("action_json") ?: return
            handleAction(json)
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        LocalBroadcastManager.getInstance(this).registerReceiver(
            receiver,
            IntentFilter(ACTION_PERFORM)
        )
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // No-op: we only use this service for on-demand actions
    }

    override fun onInterrupt() {
        // No-op
    }

    override fun onDestroy() {
        instance = null
        try {
            LocalBroadcastManager.getInstance(this).unregisterReceiver(receiver)
        } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun handleAction(json: String) {
        try {
            val obj = JSONObject(json)
            val action = obj.optString("action", "")
            val result = when (action) {
                "tap" -> performTap(obj)
                "long_press" -> performLongPress(obj)
                "scroll" -> performScroll(obj)
                "type_text" -> performTypeText(obj)
                "read_screen" -> performReadScreen()
                "find_element" -> performFindElement(obj)
                "go_back" -> performGoBack()
                "go_home" -> performGoHome()
                "open_recents" -> performOpenRecents()
                "swipe" -> performSwipe(obj)
                "take_screenshot" -> performTakeScreenshot()
                else -> JSONObject().put("success", false).put("message", "Unknown action: $action")
            }
            sendResult(result)
        } catch (e: Exception) {
            sendResult(JSONObject().put("success", false).put("message", "Error: ${e.message}"))
        }
    }

    private fun sendResult(result: JSONObject) {
        val intent = Intent(ACTION_RESULT).apply {
            putExtra("result_json", result.toString())
        }
        LocalBroadcastManager.getInstance(this).sendBroadcast(intent)
    }

    // --- Action Implementations ---

    private fun performTap(obj: JSONObject): JSONObject {
        val target = obj.optString("target", "")
        if (target.isEmpty()) {
            return JSONObject().put("success", false).put("message", "No target specified")
        }

        val node = findNodeByText(rootInActiveWindow, target)
            ?: return JSONObject().put("success", false).put("message", "Element not found: $target")

        val clickable = findClickableParent(node) ?: node
        val success = clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        node.recycle()
        if (clickable !== node) clickable.recycle()

        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Tapped on: $target" else "Failed to tap: $target")
    }

    private fun performLongPress(obj: JSONObject): JSONObject {
        val target = obj.optString("target", "")
        if (target.isEmpty()) {
            return JSONObject().put("success", false).put("message", "No target specified")
        }

        val node = findNodeByText(rootInActiveWindow, target)
            ?: return JSONObject().put("success", false).put("message", "Element not found: $target")

        val clickable = findClickableParent(node) ?: node
        val success = clickable.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK)
        node.recycle()
        if (clickable !== node) clickable.recycle()

        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Long pressed: $target" else "Failed to long press: $target")
    }

    private fun performScroll(obj: JSONObject): JSONObject {
        val direction = obj.optString("direction", "down")
        val success = when (direction.lowercase()) {
            "down" -> performGlobalAction(GLOBAL_ACTION_SCROLL_DOWN)
            "up" -> performGlobalAction(GLOBAL_ACTION_SCROLL_UP)
            "left" -> performGlobalAction(GLOBAL_ACTION_SCROLL_LEFT)
            "right" -> performGlobalAction(GLOBAL_ACTION_SCROLL_RIGHT)
            else -> {
                // Try node-level scroll
                val root = rootInActiveWindow
                val scrollable = findScrollableNode(root)
                if (scrollable != null) {
                    val scrollAction = if (direction == "up")
                        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    else
                        AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                    val result = scrollable.performAction(scrollAction)
                    scrollable.recycle()
                    result
                } else {
                    false
                }
            }
        }

        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Scrolled $direction" else "Failed to scroll $direction")
    }

    private fun performTypeText(obj: JSONObject): JSONObject {
        val text = obj.optString("text", "")
        val target = obj.optString("target", "")

        if (text.isEmpty()) {
            return JSONObject().put("success", false).put("message", "No text specified")
        }

        val root = rootInActiveWindow
            ?: return JSONObject().put("success", false).put("message", "No active window")

        // Find target field or use currently focused node
        val node = if (target.isNotEmpty()) {
            findNodeByText(root, target) ?: findFocusedInput(root)
        } else {
            findFocusedInput(root)
        }

        if (node == null) {
            return JSONObject().put("success", false).put("message", "No input field found")
        }

        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val success = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        node.recycle()

        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Typed text in field" else "Failed to type text")
    }

    private fun performReadScreen(): JSONObject {
        val root = rootInActiveWindow
            ?: return JSONObject().put("success", false).put("message", "No active window")

        val elements = JSONArray()
        traverseNodeTree(root, elements)

        return JSONObject()
            .put("success", true)
            .put("message", "Read ${elements.length()} UI elements")
            .put("data", elements)
    }

    private fun performFindElement(obj: JSONObject): JSONObject {
        val query = obj.optString("query", "")
        if (query.isEmpty()) {
            return JSONObject().put("success", false).put("message", "No query specified")
        }

        val root = rootInActiveWindow
            ?: return JSONObject().put("success", false).put("message", "No active window")

        val matches = JSONArray()
        findMatchingNodes(root, query, matches)

        return JSONObject()
            .put("success", matches.length() > 0)
            .put("message", "Found ${matches.length()} matching elements")
            .put("data", matches)
    }

    private fun performGoBack(): JSONObject {
        val success = performGlobalAction(GLOBAL_ACTION_BACK)
        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Navigated back" else "Failed to go back")
    }

    private fun performGoHome(): JSONObject {
        val success = performGlobalAction(GLOBAL_ACTION_HOME)
        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Navigated to home" else "Failed to go home")
    }

    private fun performOpenRecents(): JSONObject {
        val success = performGlobalAction(GLOBAL_ACTION_RECENTS)
        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Opened recents" else "Failed to open recents")
    }

    private fun performSwipe(obj: JSONObject): JSONObject {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
            return JSONObject().put("success", false).put("message", "Swipe requires API 24+")
        }

        val startX = obj.optInt("startX", 500).toFloat()
        val startY = obj.optInt("startY", 1000).toFloat()
        val endX = obj.optInt("endX", 500).toFloat()
        val endY = obj.optInt("endY", 500).toFloat()
        val duration = obj.optLong("duration", 300)

        val path = Path().apply {
            moveTo(startX, startY)
            lineTo(endX, endY)
        }

        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, duration))
            .build()

        var success = false
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                success = true
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                success = false
            }
        }, null)

        // Give gesture time to complete
        Thread.sleep(duration + 100)

        return JSONObject()
            .put("success", true)
            .put("message", "Swipe performed from ($startX,$startY) to ($endX,$endY)")
    }

    private fun performTakeScreenshot(): JSONObject {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            return JSONObject().put("success", false).put("message", "Screenshot requires API 28+")
        }

        val success = performGlobalAction(GLOBAL_ACTION_TAKE_SCREENSHOT)
        return JSONObject()
            .put("success", success)
            .put("message", if (success) "Screenshot taken" else "Failed to take screenshot")
    }

    // --- Helper Methods ---

    private fun findNodeByText(root: AccessibilityNodeInfo?, query: String): AccessibilityNodeInfo? {
        if (root == null) return null
        val lowerQuery = query.lowercase()

        // Check current node
        val text = root.text?.toString()?.lowercase() ?: ""
        val desc = root.contentDescription?.toString()?.lowercase() ?: ""
        val viewId = root.viewIdResourceName?.lowercase() ?: ""

        if (text.contains(lowerQuery) || desc.contains(lowerQuery) || viewId.contains(lowerQuery)) {
            return root
        }

        // Check children
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val found = findNodeByText(child, query)
            if (found != null) return found
            child.recycle()
        }

        return null
    }

    private fun findClickableParent(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var current = node.parent ?: return null
        while (!current.isClickable) {
            val parent = current.parent ?: return null
            current.recycle()
            current = parent
        }
        return current
    }

    private fun findScrollableNode(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        if (root.isScrollable) return root

        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val found = findScrollableNode(child)
            if (found != null) return found
            child.recycle()
        }
        return null
    }

    private fun findFocusedInput(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (focused != null) return focused

        // Fallback: find first editable field
        return findFirstEditable(root)
    }

    private fun findFirstEditable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        if (root == null) return null
        if (root.isEditable) return root

        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            val found = findFirstEditable(child)
            if (found != null) return found
            child.recycle()
        }
        return null
    }

    private fun traverseNodeTree(node: AccessibilityNodeInfo?, elements: JSONArray) {
        if (node == null) return

        val text = node.text?.toString() ?: ""
        val desc = node.contentDescription?.toString() ?: ""

        // Only include nodes with meaningful content
        if (text.isNotEmpty() || desc.isNotEmpty() || node.isClickable || node.isEditable) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)

            val element = JSONObject().apply {
                put("text", text)
                put("contentDescription", desc)
                put("className", node.className?.toString() ?: "")
                put("bounds", JSONObject().apply {
                    put("left", bounds.left)
                    put("top", bounds.top)
                    put("right", bounds.right)
                    put("bottom", bounds.bottom)
                })
                put("clickable", node.isClickable)
                put("scrollable", node.isScrollable)
                put("editable", node.isEditable)
                put("focused", node.isFocused)
            }
            elements.put(element)
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            traverseNodeTree(child, elements)
            child.recycle()
        }
    }

    private fun findMatchingNodes(node: AccessibilityNodeInfo?, query: String, matches: JSONArray) {
        if (node == null) return
        val lowerQuery = query.lowercase()

        val text = node.text?.toString() ?: ""
        val desc = node.contentDescription?.toString() ?: ""

        if (text.lowercase().contains(lowerQuery) || desc.lowercase().contains(lowerQuery)) {
            val bounds = Rect()
            node.getBoundsInScreen(bounds)

            matches.put(JSONObject().apply {
                put("text", text)
                put("contentDescription", desc)
                put("className", node.className?.toString() ?: "")
                put("bounds", JSONObject().apply {
                    put("left", bounds.left)
                    put("top", bounds.top)
                    put("right", bounds.right)
                    put("bottom", bounds.bottom)
                })
                put("clickable", node.isClickable)
            })
        }

        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            findMatchingNodes(child, query, matches)
            child.recycle()
        }
    }

    // Scroll global actions for API 33+
    private val GLOBAL_ACTION_SCROLL_DOWN = if (Build.VERSION.SDK_INT >= 33) 10 else -1
    private val GLOBAL_ACTION_SCROLL_UP = if (Build.VERSION.SDK_INT >= 33) 11 else -1
    private val GLOBAL_ACTION_SCROLL_LEFT = if (Build.VERSION.SDK_INT >= 33) 12 else -1
    private val GLOBAL_ACTION_SCROLL_RIGHT = if (Build.VERSION.SDK_INT >= 33) 13 else -1
}
