# import required modules
import csv
import random
from faker import Faker

def main():
	fake = Faker()
	# Ask for number of rows
	num_rows = int(input("How many rows are there? "))
	# Ask for number of attributes
	num_attrs = int(input("How many attributes do you want? "))
	attributes = []
	for i in range(num_attrs):
		name = input(f"Enter name for attribute {i+1}: ")
		print("Select type for attribute:")
		print("1. Integer")
		print("2. Float")
		print("3. String (Name)")
		print("4. String (Address)")
		print("5. String (Email)")
		print("6. String (Random Word)")
		print("7. Date (YYYY-MM-DD)")
		attr_type = int(input("Type (1-7): "))
		attributes.append((name, attr_type))

	# Generate data
	data = []
	for _ in range(num_rows):
		row = []
		for name, attr_type in attributes:
			if attr_type == 1:
				row.append(random.randint(0, 100))
			elif attr_type == 2:
				row.append(round(random.uniform(0, 100), 2))
			elif attr_type == 3:
				row.append(fake.name())
			elif attr_type == 4:
				row.append(fake.address().replace('\n', ', '))
			elif attr_type == 5:
				row.append(fake.email())
			elif attr_type == 6:
				row.append(fake.word())
			elif attr_type == 7:
				row.append(fake.date())
			else:
				row.append("")
		data.append(row)

	# Export to CSV
	filename = input("Enter filename for CSV export (e.g., data.csv): ")
	with open(filename, 'w', newline='') as f:
		writer = csv.writer(f)
		writer.writerow([name for name, _ in attributes])
		writer.writerows(data)
	print(f"Dataset exported to {filename}")

if __name__ == "__main__":
	main()
