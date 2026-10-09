import Capacitor
import UIKit
import UserNotifications

/// Device-only conveniences. Networking and certificate trust remain with URLSession/Capacitor.
@objc(NativeAppPlugin)
public class NativeAppPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAppPlugin"
    public let jsName = "NativeApp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmTerminalPaste", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testNotification", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise)
    ]

    @objc func setAppearance(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let mode = call.getString("mode") ?? "system"
            let style: UIUserInterfaceStyle = mode == "dark" ? .dark : mode == "light" ? .light : .unspecified
            self?.bridge?.viewController?.overrideUserInterfaceStyle = style
            self?.bridge?.viewController?.view.window?.overrideUserInterfaceStyle = style
            call.resolve()
        }
    }

    @objc func confirmTerminalPaste(_ call: CAPPluginCall) {
        guard let text = call.getString("text"), text.utf8.count <= 1_000_000 else {
            call.reject("Paste is too large. Use a text attachment instead."); return
        }
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.bridge?.viewController, controller.presentedViewController == nil else {
                call.resolve(["confirmed": false]); return
            }
            let preview = String(text.prefix(1800)) + (text.count > 1800 ? "\n…" : "")
            let alert = UIAlertController(title: "Paste into terminal?", message: "Newlines may run commands.\n\n" + preview, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in call.resolve(["confirmed": false]) })
            alert.addAction(UIAlertAction(title: "Paste", style: .default) { _ in call.resolve(["confirmed": true]) })
            controller.present(alert, animated: true)
        }
    }

    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch call.getString("kind") {
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            case "impact": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            default: UISelectionFeedbackGenerator().selectionChanged()
            }
            call.resolve()
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Settings are unavailable"); return
            }
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() } else { call.reject("Settings could not be opened") }
            }
        }
    }

    @objc func testNotification(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                call.reject("Enable notifications in iOS Settings first"); return
            }
            let content = UNMutableNotificationContent()
            content.title = "PiChamber"
            content.body = "Device notifications are working."
            content.sound = .default
            // One replaceable request, never a stream of test notifications.
            let request = UNNotificationRequest(identifier: "pichamber-device-test", content: content,
                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 5, repeats: false))
            center.add(request) { error in
                if error != nil { call.reject("Test notification could not be scheduled") }
                else { call.resolve() }
            }
        }
    }

    @objc func shareFile(_ call: CAPPluginCall) {
        guard let base64 = call.getString("base64"), base64.utf8.count <= 35_000_000,
              let data = Data(base64Encoded: base64), data.count <= 25_000_000 else {
            call.reject("File is too large or invalid"); return
        }
        let requestedName = call.getString("filename") ?? "pichamber-export.txt"
        let filename = URL(fileURLWithPath: requestedName).lastPathComponent
        guard !filename.isEmpty, filename != ".", filename != ".." else {
            call.reject("Invalid filename"); return
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(filename)
            try data.write(to: url, options: .atomic)
            DispatchQueue.main.async { [weak self] in
                guard let controller = self?.bridge?.viewController, controller.presentedViewController == nil else {
                    try? FileManager.default.removeItem(at: folder)
                    call.reject("Close the current sheet before sharing"); return
                }
                let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                sheet.popoverPresentationController?.sourceView = controller.view
                sheet.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                sheet.completionWithItemsHandler = { _, completed, _, error in
                    try? FileManager.default.removeItem(at: folder)
                    if error != nil { call.reject("Sharing failed") }
                    else { call.resolve(["completed": completed]) }
                }
                controller.present(sheet, animated: true)
            }
        } catch {
            try? FileManager.default.removeItem(at: folder)
            call.reject("Export file could not be prepared")
        }
    }
}
