require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorCloudKv'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'MIT' }
  s.homepage = 'https://github.com/vilicvane/monoid'
  s.author = 'Monoid'
  s.source = { :git => 'https://github.com/vilicvane/monoid.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.swift'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor', '~> 8.0'
  s.swift_version = '5.9'
end
