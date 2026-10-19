import AVFoundation
import UIKit

/// Permission replies and activation notifications are independent; all calls run on main.
final class QrCameraPermissions {
    private let authorizationStatus: () -> AVAuthorizationStatus
    private let requestAccess: (@escaping () -> Void) -> Void
    private let applicationState: () -> UIApplication.State
    private let sceneState: () -> UIScene.ActivationState?
    private var completions: [(String) -> Void] = []
    private var requesting = false
    private var awaitingPromptActivation = false

    init(authorizationStatus: @escaping () -> AVAuthorizationStatus,
         requestAccess: @escaping (@escaping () -> Void) -> Void,
         applicationState: @escaping () -> UIApplication.State,
         sceneState: @escaping () -> UIScene.ActivationState?) {
        self.authorizationStatus = authorizationStatus
        self.requestAccess = requestAccess
        self.applicationState = applicationState
        self.sceneState = sceneState
    }

    var state: String {
        switch authorizationStatus() {
        case .authorized: return "granted"
        case .notDetermined: return "prompt"
        default: return "denied"
        }
    }

    var isAppActive: Bool {
        // A permission sheet can make the application inactive while its scene
        // still reports foregroundActive. Both must be ready before camera use.
        applicationState() == .active && sceneState() == .foregroundActive
    }

    var canStartScan: Bool {
        !requesting && !awaitingPromptActivation && isAppActive
    }

    func request(completion: @escaping (String) -> Void) {
        completions.append(completion)
        if authorizationStatus() == .notDetermined {
            guard !requesting else { return }
            requesting = true
            // Activity snapshots are insufficient here: the camera
            // authorization callback can precede the prompt's deactivation events.
            // Arm before presenting it and wait for the following app activation.
            awaitingPromptActivation = true
            requestAccess { [weak self] in
                guard let self else { return }
                self.requesting = false
                self.finishIfActive()
            }
        } else {
            finishIfActive()
        }
    }

    func finishIfActive() {
        guard canStartScan else { return }
        let pending = completions
        completions.removeAll()
        let state = state
        for completion in pending { completion(state) }
    }

    func applicationDidBecomeActive() {
        awaitingPromptActivation = false
        finishIfActive()
    }

    func resetDocument() {
        completions.removeAll()
    }
}
