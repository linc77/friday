import SwiftUI

// Keep UI copy in the package bundle. SwiftUI's locale environment updates these
// controls in place, without recreating the conversation or its editing state.
extension Text {
    init(friday key: LocalizedStringKey) {
        self.init(key, bundle: .module)
    }

    init(fridayString key: String) {
        self.init(LocalizedStringKey(key), bundle: .module)
    }
}

extension Label where Title == Text, Icon == Image {
    init(friday title: String, systemImage: String) {
        self.init { Text(fridayString: title) } icon: { Image(systemName: systemImage) }
    }
}

extension Button where Label == Text {
    init(friday title: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { Text(fridayString: title) }
    }
}

extension Button where Label == SwiftUI.Label<Text, Image> {
    init(friday title: String, systemImage: String, role: ButtonRole? = nil, action: @escaping () -> Void) {
        self.init(role: role, action: action) { SwiftUI.Label(friday: title, systemImage: systemImage) }
    }
}

extension TextField where Label == Text {
    init(friday title: String, text: Binding<String>, axis: Axis = .horizontal) {
        self.init(text: text, prompt: Text(fridayString: title), axis: axis) { Text(fridayString: title) }
    }
}

extension SecureField where Label == Text {
    init(friday title: String, text: Binding<String>) {
        self.init(text: text, prompt: Text(fridayString: title)) { Text(fridayString: title) }
    }
}

extension NavigationLink where Label == Text {
    init(friday title: String, @ViewBuilder destination: () -> Destination) {
        self.init(destination: destination) { Text(fridayString: title) }
    }
}
