require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "TracesiftProfiler"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.license      = package["license"]
  s.homepage     = "https://github.com/callstack/tracesift"
  s.authors      = "Callstack"
  s.platforms    = { :ios => "15.1" }
  s.source       = { :git => "https://github.com/callstack/tracesift.git", :tag => "v#{s.version}" }
  s.source_files = "ios/*.{h,m,mm}"

  s.frameworks   = "UIKit"
  s.pod_target_xcconfig = {
    "CLANG_CXX_LANGUAGE_STANDARD" => "c++20",
    "CLANG_CXX_LIBRARY" => "libc++",
    # hermes.h is a C++ header that includes jsi; both ship with the stock
    # hermes-engine pod, so nothing is built from source.
    "HEADER_SEARCH_PATHS" => '"$(PODS_ROOT)/hermes-engine/destroot/include" "$(PODS_ROOT)/Headers/Public/hermes-engine"',
  }

  # Hermes' sampling profiler is reached through IHermesRootAPI in the
  # hermesvm framework the app already links.
  s.dependency "hermes-engine"
  if respond_to?(:install_modules_dependencies, true)
    install_modules_dependencies(s)
  else
    s.dependency "React-Core"
  end
end
