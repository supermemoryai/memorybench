export const ragBenchmarkData = [
	{
		id: "rag_001",
		question: "What is the capital of France?",
		expected_answer: "Paris is the capital of France.",
		documents: [
			{
				id: "doc_1",
				content:
					"Paris is the capital and most populous city of France. With an official estimated population of 2,102,650 residents as of 1 January 2023 in an area of more than 105 km², Paris is the fourth-largest city in the European Union and the 30th most densely populated city in the world in 2022.",
				title: "Geography of France",
				source: "encyclopedia",
			},
			{
				id: "doc_2",
				content:
					"France is a country primarily located in Western Europe. It also comprises of various overseas regions and territories in the Americas and the Atlantic, Pacific and Indian Oceans.",
				title: "France Overview",
				source: "geography_textbook",
			},
		],
		metadata: {
			difficulty: "easy",
			category: "geography",
			source_dataset: "basic_qa",
		},
	},
	{
		id: "rag_002",
		question: "How does photosynthesis work in plants?",
		expected_answer:
			"Photosynthesis is the process by which plants convert light energy, usually from the sun, into chemical energy stored in glucose. This process occurs in chloroplasts and involves two main stages: light-dependent reactions and the Calvin cycle.",
		documents: [
			{
				id: "doc_3",
				content:
					"Photosynthesis is a process used by plants and other organisms to convert light energy into chemical energy that, through cellular respiration, can later be released to fuel the organism's activities. This chemical energy is stored in carbohydrate molecules, such as sugars and starches, which are synthesized from carbon dioxide and water.",
				title: "Photosynthesis Process",
				source: "biology_textbook",
			},
			{
				id: "doc_4",
				content:
					"The process of photosynthesis occurs in two stages: the light-dependent reactions and the light-independent reactions (Calvin cycle). The light-dependent reactions occur in the thylakoid membranes of chloroplasts, while the Calvin cycle takes place in the stroma.",
				title: "Stages of Photosynthesis",
				source: "plant_biology",
			},
			{
				id: "doc_5",
				content:
					"Chloroplasts are organelles found in plant cells and eukaryotic algae that conduct photosynthesis. Chloroplasts absorb sunlight and use it in conjunction with water and carbon dioxide gas to produce food for the plant.",
				title: "Chloroplasts Function",
				source: "cell_biology",
			},
		],
		metadata: {
			difficulty: "medium",
			category: "biology",
			source_dataset: "science_qa",
		},
	},
	{
		id: "rag_003",
		question:
			"Explain the economic implications of quantum computing on current cryptographic systems.",
		expected_answer:
			"Quantum computing poses significant economic risks to current cryptographic systems as it could break widely-used encryption methods like RSA and ECC, potentially compromising trillions of dollars in digital transactions, requiring massive investment in quantum-resistant cryptography, and creating new cybersecurity markets worth billions.",
		documents: [
			{
				id: "doc_6",
				content:
					"Quantum computers have the potential to break many of the cryptographic systems that are currently used to secure digital communications. This is because quantum algorithms, such as Shor's algorithm, can efficiently factor large integers and compute discrete logarithms, which are the mathematical problems underlying RSA and elliptic curve cryptography.",
				title: "Quantum Computing and Cryptography",
				source: "cybersecurity_journal",
			},
			{
				id: "doc_7",
				content:
					"The global cybersecurity market was valued at approximately $173 billion in 2022 and is expected to grow significantly. The advent of practical quantum computing could create entirely new market segments focused on quantum-resistant cryptography and post-quantum security solutions.",
				title: "Cybersecurity Market Analysis",
				source: "market_research",
			},
			{
				id: "doc_8",
				content:
					"Financial institutions process trillions of dollars in digital transactions daily, all protected by current cryptographic standards. The transition to quantum-resistant cryptography is estimated to cost the global economy hundreds of billions of dollars in infrastructure upgrades and system replacements.",
				title: "Economic Impact of Cryptography",
				source: "financial_technology",
			},
		],
		metadata: {
			difficulty: "hard",
			category: "technology",
			source_dataset: "expert_qa",
		},
	},
];
