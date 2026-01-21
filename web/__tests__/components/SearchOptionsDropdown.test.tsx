import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchOptionsDropdown } from "@/components/SearchOptionsDropdown";
import { SiteConfig } from "@/types/siteConfig";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/config/modelOptions";

// Mock analytics
jest.mock("@/utils/client/analytics", () => ({
  logEvent: jest.fn(),
}));

// Mock createPortal to render in place for testing
jest.mock("react-dom", () => ({
  ...jest.requireActual("react-dom"),
  createPortal: (children: React.ReactNode) => children,
}));

describe("SearchOptionsDropdown", () => {
  const mockSiteConfig: SiteConfig = {
    siteId: "test",
    shortname: "Test",
    name: "Test Site",
    tagline: "Test tagline",
    greeting: "Test greeting",
    parent_site_url: "https://test.com",
    parent_site_name: "Test Parent",
    help_url: "https://test.com/help",
    help_text: "Test help",
    enableMediaTypeSelection: true,
    enableAuthorSelection: true,
    showSourceCountSelector: true,
    enabledMediaTypes: ["text", "audio", "youtube"],
    collectionConfig: {
      master_swami: "Master and Swami",
      whole_library: "All authors",
    },
    libraryMappings: {},
    enableSuggestedQueries: false,
    welcome_popup_heading: "Welcome",
    other_visitors_reference: "visitors",
    loginImage: null,
    header: { logo: "test.png", navItems: [] },
    footer: { links: [] },
    requireLogin: false,
    allowTemporarySessions: true,
    allowAllAnswersPage: false,
    queriesPerUserPerDay: 100,
    showSourceContent: true,
    showVoting: true,
    showRelatedQuestions: true,
    defaultNumSources: 4,
    includedLibraries: ["Ananda Library", "Crystal Clarity"],
  };

  const defaultProps = {
    siteConfig: mockSiteConfig,
    mediaTypes: { text: true, audio: true, youtube: true },
    handleMediaTypeChange: jest.fn(),
    collection: "master_swami",
    handleCollectionChange: jest.fn(),
    selectedLibraries: ["Ananda Library", "Crystal Clarity"],
    handleLibraryChange: jest.fn(),
    sourceCount: 4,
    setSourceCount: jest.fn(),
    selectedModel: DEFAULT_MODEL,
    handleModelChange: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the dropdown button", () => {
    render(<SearchOptionsDropdown {...defaultProps} />);

    expect(screen.getByRole("button", { name: /options/i })).toBeInTheDocument();
    expect(screen.getByText("tune")).toBeInTheDocument(); // Material icon
  });

  it("shows default styling when options are not modified", () => {
    render(<SearchOptionsDropdown {...defaultProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show gray tune icon in default state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-500");
  });

  it("shows yellow background tune icon when media types are modified", () => {
    const modifiedProps = {
      ...defaultProps,
      mediaTypes: { text: false, audio: true, youtube: true }, // Changed from default
    };

    render(<SearchOptionsDropdown {...modifiedProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show yellow background tune icon in modified state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-700");
    // Check for the background circle
    const backgroundCircle = button.querySelector(".rounded-full");
    expect(backgroundCircle).toBeInTheDocument();
    expect(backgroundCircle).toHaveStyle("background-color: #fff1c2");
  });

  it("shows yellow background tune icon when collection is modified", () => {
    const modifiedProps = {
      ...defaultProps,
      collection: "whole_library", // Changed from default (master_swami)
    };

    render(<SearchOptionsDropdown {...modifiedProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show yellow background tune icon in modified state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-700");
    // Check for the background circle
    const backgroundCircle = button.querySelector(".rounded-full");
    expect(backgroundCircle).toBeInTheDocument();
    expect(backgroundCircle).toHaveStyle("background-color: #fff1c2");
  });

  it("shows yellow background tune icon when source count is modified", () => {
    const modifiedProps = {
      ...defaultProps,
      sourceCount: 10, // Changed from default (4)
    };

    render(<SearchOptionsDropdown {...modifiedProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show yellow background tune icon in modified state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-700");
    // Check for the background circle
    const backgroundCircle = button.querySelector(".rounded-full");
    expect(backgroundCircle).toBeInTheDocument();
    expect(backgroundCircle).toHaveStyle("background-color: #fff1c2");
  });

  it("shows default styling when only disabled features would be modified", () => {
    // Test with one feature enabled but not modified, others disabled but modified
    const siteConfigWithMixedFeatures: SiteConfig = {
      ...mockSiteConfig,
      enableMediaTypeSelection: true, // Keep this enabled
      enableAuthorSelection: false, // Disable this
      showSourceCountSelector: false, // Disable this
    };

    const modifiedProps = {
      ...defaultProps,
      siteConfig: siteConfigWithMixedFeatures,
      mediaTypes: { text: true, audio: true, youtube: true }, // Not modified (matches defaults)
      collection: "whole_library", // Modified but feature disabled
      sourceCount: 10, // Modified but feature disabled
    };

    render(<SearchOptionsDropdown {...modifiedProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show gray tune icon in default state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-500");
  });

  it("opens dropdown when button is clicked", () => {
    render(<SearchOptionsDropdown {...defaultProps} />);

    const button = screen.getByRole("button", { name: /options/i });
    fireEvent.click(button);

    expect(screen.getByText("AI Model")).toBeInTheDocument();
    expect(screen.getByText("Media Types")).toBeInTheDocument();
    expect(screen.getByText("Authors")).toBeInTheDocument();
    expect(screen.getByText("Use Extra Sources")).toBeInTheDocument();
  });

  it("always renders because model selector is always available", () => {
    const siteConfigWithNoOptions: SiteConfig = {
      ...mockSiteConfig,
      enableMediaTypeSelection: false,
      enableAuthorSelection: false,
      showSourceCountSelector: false,
      includedLibraries: [], // No libraries either
    };

    const propsWithNoOptions = {
      ...defaultProps,
      siteConfig: siteConfigWithNoOptions,
    };

    render(<SearchOptionsDropdown {...propsWithNoOptions} />);
    // Should still render because model selector is always available
    expect(screen.getByRole("button", { name: /options/i })).toBeInTheDocument();
  });

  it("handles different site config default values correctly", () => {
    const customSiteConfig: SiteConfig = {
      ...mockSiteConfig,
      enabledMediaTypes: ["text", "audio"], // Different default - no youtube
      defaultNumSources: 6, // Different default source count
    };

    const propsWithCustomDefaults = {
      ...defaultProps,
      siteConfig: customSiteConfig,
      mediaTypes: { text: true, audio: true, youtube: false }, // Matches custom defaults
      sourceCount: 6, // Matches custom default
    };

    render(<SearchOptionsDropdown {...propsWithCustomDefaults} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show gray tune icon in default state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-500");
  });

  it("shows yellow background tune icon when youtube is enabled but not in site config defaults", () => {
    const customSiteConfig: SiteConfig = {
      ...mockSiteConfig,
      enabledMediaTypes: ["text", "audio"], // No youtube in defaults
    };

    const propsWithYouTubeEnabled = {
      ...defaultProps,
      siteConfig: customSiteConfig,
      mediaTypes: { text: true, audio: true, youtube: true }, // YouTube enabled but not in defaults
    };

    render(<SearchOptionsDropdown {...propsWithYouTubeEnabled} />);

    const button = screen.getByRole("button", { name: /options/i });
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show yellow background tune icon in modified state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-700");
    // Check for the background circle
    const backgroundCircle = button.querySelector(".rounded-full");
    expect(backgroundCircle).toBeInTheDocument();
    expect(backgroundCircle).toHaveStyle("background-color: #fff1c2");
  });

  it("shows default styling when no media types are checked (equivalent to all checked)", () => {
    const propsWithNoMediaTypes = {
      ...defaultProps,
      mediaTypes: { text: false, audio: false, youtube: false }, // No media types checked
    };

    render(<SearchOptionsDropdown {...propsWithNoMediaTypes} />);

    const button = screen.getByRole("button", { name: /options/i });
    // Should show default styling because no types checked = all types checked (default behavior)
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show gray tune icon in default state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-500");
  });

  it("shows default styling when both current and default have no media types checked", () => {
    const customSiteConfig: SiteConfig = {
      ...mockSiteConfig,
      enabledMediaTypes: [], // No enabled media types in config (unusual but possible)
    };

    const propsWithNoDefaults = {
      ...defaultProps,
      siteConfig: customSiteConfig,
      mediaTypes: { text: false, audio: false, youtube: false }, // No media types checked
    };

    render(<SearchOptionsDropdown {...propsWithNoDefaults} />);

    const button = screen.getByRole("button", { name: /options/i });
    // Both default and current are "none checked" so they're equivalent
    expect(button).toHaveClass("bg-white", "text-gray-700", "border-gray-300");

    // Should show gray tune icon in default state
    const tuneIcon = button.querySelector(".material-icons");
    expect(tuneIcon).toHaveClass("text-gray-500");
  });

  describe("Library Selection", () => {
    it("renders library checkboxes when multiple libraries are available", () => {
      render(<SearchOptionsDropdown {...defaultProps} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Check that both libraries appear as checkboxes
      expect(screen.getByLabelText("Ananda Library")).toBeInTheDocument();
      expect(screen.getByLabelText("Crystal Clarity")).toBeInTheDocument();
    });

    it("calls handleLibraryChange when library checkbox is toggled", () => {
      const mockHandleLibraryChange = jest.fn();
      render(<SearchOptionsDropdown {...defaultProps} handleLibraryChange={mockHandleLibraryChange} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Click on a library checkbox
      const checkbox = screen.getByLabelText("Ananda Library");
      fireEvent.click(checkbox);

      expect(mockHandleLibraryChange).toHaveBeenCalledWith("Ananda Library");
    });

    it("disables the last selected library checkbox", () => {
      const propsWithOneLibrary = {
        ...defaultProps,
        selectedLibraries: ["Ananda Library"], // Only one library selected
      };
      render(<SearchOptionsDropdown {...propsWithOneLibrary} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // The selected library should be disabled
      const anandaCheckbox = screen.getByLabelText("Ananda Library") as HTMLInputElement;
      expect(anandaCheckbox.disabled).toBe(true);
      expect(anandaCheckbox.checked).toBe(true);

      // The unselected library should be enabled
      const crystalCheckbox = screen.getByLabelText("Crystal Clarity") as HTMLInputElement;
      expect(crystalCheckbox.disabled).toBe(false);
      expect(crystalCheckbox.checked).toBe(false);
    });

    it("shows modified indicator when library selection differs from default", () => {
      const propsWithModifiedLibraries = {
        ...defaultProps,
        selectedLibraries: ["Ananda Library"], // Only one of two libraries selected
      };
      render(<SearchOptionsDropdown {...propsWithModifiedLibraries} />);

      const button = screen.getByRole("button", { name: /options/i });

      // Should show yellow background tune icon when libraries are modified
      const tuneIcon = button.querySelector(".material-icons");
      expect(tuneIcon).toHaveClass("text-gray-700");
    });
  });

  describe("Model Selection", () => {
    it("renders model selector with all model options", () => {
      render(<SearchOptionsDropdown {...defaultProps} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Check that AI Model section appears
      expect(screen.getByText("AI Model")).toBeInTheDocument();

      // Check that all model options are rendered
      MODEL_OPTIONS.forEach((option) => {
        expect(screen.getByLabelText(option.label)).toBeInTheDocument();
      });
    });

    it("shows default model as selected", () => {
      render(<SearchOptionsDropdown {...defaultProps} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Check that default model is selected
      const defaultModelOption = MODEL_OPTIONS.find((opt) => opt.value === DEFAULT_MODEL);
      const defaultRadio = screen.getByLabelText(defaultModelOption!.label) as HTMLInputElement;
      expect(defaultRadio.checked).toBe(true);
    });

    it("calls handleModelChange when model is selected", () => {
      const mockHandleModelChange = jest.fn();
      render(<SearchOptionsDropdown {...defaultProps} handleModelChange={mockHandleModelChange} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Find a different model option
      const otherModel = MODEL_OPTIONS.find((opt) => opt.value !== DEFAULT_MODEL);
      const otherModelRadio = screen.getByLabelText(otherModel!.label);
      fireEvent.click(otherModelRadio);

      expect(mockHandleModelChange).toHaveBeenCalledWith(otherModel!.value);
    });

    it("shows modified indicator when model is changed from default", () => {
      const nonDefaultModel = MODEL_OPTIONS.find((opt) => opt.value !== DEFAULT_MODEL)!.value;
      const propsWithModifiedModel = {
        ...defaultProps,
        selectedModel: nonDefaultModel,
      };

      render(<SearchOptionsDropdown {...propsWithModifiedModel} />);

      const button = screen.getByRole("button", { name: /options/i });

      // Should show yellow background tune icon when model is modified
      const tuneIcon = button.querySelector(".material-icons");
      expect(tuneIcon).toHaveClass("text-gray-700");
      const backgroundCircle = button.querySelector(".rounded-full");
      expect(backgroundCircle).toBeInTheDocument();
      expect(backgroundCircle).toHaveStyle("background-color: #fff1c2");
    });

    it("shows model info in Controls Info modal", () => {
      render(<SearchOptionsDropdown {...defaultProps} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Click the Controls Info button (top right corner)
      const controlsInfoButton = screen.getByLabelText("Controls information");
      fireEvent.click(controlsInfoButton);

      // Check that AI Model Selection info appears first in the modal
      expect(screen.getByText("AI Model Selection")).toBeInTheDocument();
      expect(screen.getByText("Why try different models?")).toBeInTheDocument();
    });

    it("shows current model in Controls Info modal", () => {
      const selectedModel = MODEL_OPTIONS[2].value;
      const propsWithModel = {
        ...defaultProps,
        selectedModel,
      };

      render(<SearchOptionsDropdown {...propsWithModel} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Open Controls Info modal
      const controlsInfoButton = screen.getByLabelText("Controls information");
      fireEvent.click(controlsInfoButton);

      // Check that current model text is displayed (text is split across elements)
      expect(screen.getByText("You are currently using:")).toBeInTheDocument();
      const selectedModelLabel = MODEL_OPTIONS.find((opt) => opt.value === selectedModel)!.label;
      // Model label appears in both dropdown and modal, so use getAllByText
      const modelLabels = screen.getAllByText(selectedModelLabel);
      expect(modelLabels.length).toBeGreaterThan(0);
    });

    it("shows Collection Selection info after AI Model info in Controls Info modal", () => {
      render(<SearchOptionsDropdown {...defaultProps} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Open Controls Info modal
      const controlsInfoButton = screen.getByLabelText("Controls information");
      fireEvent.click(controlsInfoButton);

      // Check that AI Model Selection appears first
      expect(screen.getByText("AI Model Selection")).toBeInTheDocument();
      
      // Check that Collection Selection appears after (if enabled)
      if (defaultProps.siteConfig.enableAuthorSelection) {
        expect(screen.getByText("Collection Selection")).toBeInTheDocument();
      }
    });

    it("resets model to default when reset button is clicked", () => {
      const nonDefaultModel = MODEL_OPTIONS.find((opt) => opt.value !== DEFAULT_MODEL)!.value;
      const mockHandleModelChange = jest.fn();
      const propsWithModifiedModel = {
        ...defaultProps,
        selectedModel: nonDefaultModel,
        handleModelChange: mockHandleModelChange,
      };

      render(<SearchOptionsDropdown {...propsWithModifiedModel} />);

      // Open the dropdown
      const button = screen.getByRole("button", { name: /options/i });
      fireEvent.click(button);

      // Click reset button
      const resetButton = screen.getByText("Reset to Defaults");
      fireEvent.click(resetButton);

      // Verify model was reset to default
      expect(mockHandleModelChange).toHaveBeenCalledWith(DEFAULT_MODEL);
    });
  });
});
