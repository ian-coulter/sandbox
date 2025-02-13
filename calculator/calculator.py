##############################
# Just a simple calculator #
##############################

# Calculation function
def calcs(choice, x,y):
    if choice == '1':
        ops=('+')
        output_raw=x+y
    elif choice == '2':
        ops=('-')
        output_raw=x-y
    elif choice == '3':
        ops=('*')
        output_raw=x*y
    elif choice == '4':
        ops=('/')
        if y == 0:
            return ("You can't divide by 0")
        else:
            output_raw=x/y

    output = (f"The result of ({x}{ops}{y}) is {output_raw}")
    return output

# Grabbing the first and second number, then run calculations
def math(choice):
    try:
        x=float(input("What is your first number? "))
        y=float(input("What is your second number? "))
    except ValueError:
        print("You didn't enter a number")
        return

    print(calcs(choice, x, y))

# Variable(s)    
invalid_input = ("!!! You typed an invalid option, please try again !!!")

# What math do you want to do?
def main_calc():
    while True:
        choice = input("\nSelect your operation\n1. Add\n2. Subtract\n3. Multiply\n4. Divide\n\nOption: ")
        if choice in ['1','2','3','4']:
            math(choice)
            break
        elif choice != ['1','2','3','4']:
            print(invalid_input)
            continue

# Want to do more math?
def more_calc():
    while True:
        more_math = input("\nDo you want to do another math? (y/n): ")
        if more_math == 'y':
            main_calc()
        elif more_math == 'n':
            quit()
        else:
            print(invalid_input)

#####################
# Let's do things now
#####################

# Funtion to kick off calculator
main_calc()

# After primary math, will ask if you want to do more math
more_calc()