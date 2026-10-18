// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CapacitorBiometricVault",
    platforms: [.iOS(.v15)],
    products: [.library(name: "CapacitorBiometricVault", targets: ["BiometricVaultPlugin"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "BiometricVaultPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
            ],
            path: "ios/Sources/BiometricVaultPlugin",
            resources: [.process("PrivacyInfo.xcprivacy")]),
        .testTarget(
            name: "BiometricVaultPluginTests",
            dependencies: ["BiometricVaultPlugin"],
            path: "ios/Tests/BiometricVaultPluginTests"),
    ]
)
