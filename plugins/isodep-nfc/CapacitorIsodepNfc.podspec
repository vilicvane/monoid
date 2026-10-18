require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'CapacitorIsodepNfc'
  s.version = package['version']
  s.summary = package['description']
  s.license = { :type => 'MIT' }
  s.homepage = 'https://github.com/vilicvane/monoid'
  s.author = 'Monoid'
  s.source = { :git => 'https://github.com/vilicvane/monoid.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor', '~> 8.0'
  s.frameworks = 'CoreNFC'
  s.swift_version = '5.9'
end
