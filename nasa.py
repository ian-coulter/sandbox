import requests
import os

# NASA API and search parameter
nasa_api = "https://images-api.nasa.gov"
search_for = input("What do you want to search the NASA images API for? ")
output_dir = (f"{search_for.replace(' ', '_')}_images")

def download_things(output_dir=output_dir):
    try:
        # Create the output directory if it doesn't exist
        os.makedirs(output_dir, exist_ok=True)

        # Search for term in the NASA Images API
        search_url = f"{nasa_api}/search"
        params = {"q": {search_for}, "media_type": "image"}
        response = requests.get(search_url, params=params)
        response.raise_for_status()
        search_results = response.json()

        # Extract all image items from the search results
        items = search_results.get("collection", {}).get("items", [])
        if not items:
            print(f"No images found for {search_for}.")
            return

        # Limit the number of images to 20
        items = items[:20]

        # Download each image
        for index, item in enumerate(items):
            image_links = item.get("links", [])
            if not image_links:
                print(f"No image links found for item {index + 1}. Skipping...")
                continue

            # Look for the highest resolution or raw image URL
            raw_image_url = None
            for link in image_links:
                href = link.get("href", "")
                if "orig" in href or "raw" in href:  # Check for raw or original keywords
                    raw_image_url = href
                    break
            if not raw_image_url:
                raw_image_url = image_links[0].get("href")  # Fallback to the first available link

            if not raw_image_url:
                print(f"No valid image URL found for item {index + 1}. Skipping...")
                continue

            # Download the image
            image_response = requests.get(raw_image_url)
            image_response.raise_for_status()

            # Save the image to the output directory
            output_path = os.path.join(output_dir, f"{search_for.replace(' ', '_')}_{index + 1}.jpg")
            with open(output_path, "wb") as file:
                file.write(image_response.content)
            print(f"Raw image {index + 1} saved as {output_path}")

    except requests.exceptions.RequestException as e:
        print(f"Failed to download {search_for} images: {e}")

if __name__ == "__main__":
    download_things()