import Foundation

@main struct HealthAggregationTests {
    static func main() {
        let origin = Date(timeIntervalSince1970: 0)
        let date: (Double) -> Date = { origin.addingTimeInterval($0 * 60) }
        precondition(healthIntervalMinutes([], within: (date(0), date(100))) == nil)
        precondition(healthIntervalMinutes([(date(10), date(40)), (date(20), date(60)), (date(10), date(40))], within: (date(0), date(100))) == 50)
        precondition(healthIntervalMinutes([(date(-10), date(20)), (date(50), date(120))], within: (date(0), date(100))) == 70)
        precondition(healthIntervalMinutes([(date(100), date(120))], within: (date(0), date(100))) == nil)
        print("Health aggregation checks passed")
    }
}
